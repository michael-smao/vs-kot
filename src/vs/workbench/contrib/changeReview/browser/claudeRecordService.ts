/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: keeps the record of what Claude Code changed. See ../common/claudeRecord.ts for what that is.
//
// The folder of the record is shared by every window, and by the installed editor and one run from source:
//
//   hook.sh                   the script that Claude Code runs after a tool call
//   heard                     written by every run of the script: how that session was started
//   events/<time>-<pid>.json  what Claude Code handed the script, one file per tool call that changed files
//   files/<hash>/<event>.json one entry per changed file, in a folder named after the hash of its path
//
// Every window reads the events and writes the entries for them. Two windows write the same entry for the same
// event, so it does not matter which one is first. An event is taken away once every window had time to read it:
// it holds whole files, an entry only hashes of their lines.
//
// For what Claude Code staged or committed, the folder also has:
//
//   repos/<hash>              one file per repository that is reviewed in this editor, with the path of its folder
//   pending/<tool call>/      what the script noted before a shell command that is still running
//   events/<time>-<pid>-<n>.git  which staged versions a shell command changed, see parseClaudeGitEvent
//   held/<hash>.json          one file per file that stays under review although its changes are staged
//   own/<hash>.json           what the reviewer last staged in a file themselves
//
// None of these holds a line of a file: versions are named by the id that git has for them.

import { DeferredPromise, IntervalTimer, RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { untildify } from '../../../../base/common/labels.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { sep } from '../../../../base/common/path.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { addClaudeHooks, applyClaudeStaging, CLAUDE_HOOK_SCRIPT, CLAUDE_RECORD_FOLDER_SETTING, CLAUDE_SETTINGS_FILE_SETTING, ClaudeConnectionState, ClaudeHooks, ClaudeSettingsError, digestClaudeGoneEvent, digestClaudeHookInput, getClaudeHooks, getClaudeStagings, IClaudeHold, IClaudeLastHeard, IClaudeRecordEntry, IClaudeRecordService, IClaudeStaging, IOwnStaging, isCurrentClaudeHookScript, parseClaudeGitEvent, parseClaudeHold, parseClaudeRecordEntry, parseOwnStaging, removeClaudeHooks } from '../common/claudeRecord.js';

/** How long an event is kept after the script stored it. Every open window reads it within a moment. */
const EVENT_KEPT_MS = 10 * 60 * 1000;
/** How long an entry is kept. A change that is still not reviewed by then is shown as before, without its mark. */
const ENTRY_KEPT_MS = 14 * 24 * 60 * 60 * 1000;
/** An event holds the file a tool wrote, up to three times. Larger ones are not read. */
const MAX_EVENT_SIZE = 32 * 1024 * 1024;

/** How long a file is held under review. After that it is taken as git has it, the way it was before there were holds. */
const HOLD_KEPT_MS = 60 * 24 * 60 * 60 * 1000;
/** A repository that no window has had open for this long is not looked at by the script anymore. */
const REPOSITORY_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
/** What the script noted before a shell command is of no use once the command cannot be running anymore. */
const SNAPSHOT_KEPT_MS = 15 * 60 * 1000;

// Only what has one of these names is ever deleted, wherever a setting points the folder of the record
const EVENT_NAME = /^\d+-\d+\.json$/;
const GIT_EVENT_NAME = /^\d+-\d+-\d+\.git$/;
const GONE_EVENT_NAME = /^\d+-\d+-\d+\.gone$/;
/** An entry is named after the event it came from. */
const ENTRY_NAME = /^\d+-\d+(-\d+)?\.json$/;
const UNFINISHED_EVENT_NAME = /^\.\d+\.tmp$/;
const ENTRIES_FOLDER_NAME = /^[0-9a-f]{40}$/;
const HASHED_NAME = /^[0-9a-f]{40}(\.json)?$/;

/** What tells the reviewer something about a hold. Two that agree in this are the same to them. */
function getHoldSignature(hold: IClaudeHold | undefined): string {
	return hold && hold.released === undefined ? `${hold.reviewed}|${hold.staged}|${hold.isCommitted}` : '';
}

interface IFileRecord {
	readonly entries: IClaudeRecordEntry[];
	/** The names of the events that {@link entries} came from. */
	readonly events: Set<string>;
}

export class ClaudeRecordService extends Disposable implements IClaudeRecordService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnection = this._register(new Emitter<void>());
	readonly onDidChangeConnection: Event<void> = this._onDidChangeConnection.event;

	private readonly _onDidChangeRecord = this._register(new Emitter<URI>());
	readonly onDidChangeRecord: Event<URI> = this._onDidChangeRecord.event;

	private _connectionState = ClaudeConnectionState.Unknown;
	private _settingsFile: URI;
	private _recordFolder: URI;

	private readonly _settingsWatcher = this._register(new MutableDisposable<DisposableStore>());
	private readonly _eventsWatcher = this._register(new MutableDisposable<DisposableStore>());
	private readonly _connectionSequencer = new Sequencer();
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => this.refreshConnection(), 300));

	private readonly _scanScheduler = this._register(new RunOnceScheduler(() => this._scanEvents(), 150));
	private readonly _scanSequencer = new Sequencer();
	/** The events this window has read. */
	private readonly _readEvents = new Set<string>();
	private readonly _sweepScheduler = this._register(new RunOnceScheduler(() => this._sweepEntries(), 60_000));

	/** What is on record for the files that were asked about, by path. */
	private readonly _records = new Map<string, IFileRecord>();

	private readonly _onDidChangeHolds = this._register(new Emitter<URI>());
	readonly onDidChangeHolds: Event<URI> = this._onDidChangeHolds.event;

	/** What is stored for the files that are held under review, and for those that were until lately, by path. */
	private _holds = new Map<string, IClaudeHold>();
	private readonly _holdsKnown = new DeferredPromise<void>();
	/** What is stored for a file is read, changed and written again by one at a time. */
	private readonly _holdSequencer = new Sequencer();
	private readonly _holdsWatcher = this._register(new MutableDisposable<DisposableStore>());
	private readonly _loadHoldsScheduler = this._register(new RunOnceScheduler(() => this._loadHolds(), 200));
	/** The folders of the repositories that are reviewed in this window. */
	private readonly _repositories = new Set<string>();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IPathService private readonly _pathService: IPathService,
		@IProductService private readonly _productService: IProductService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILabelService private readonly _labelService: ILabelService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		[this._settingsFile, this._recordFolder] = this._getLocations();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CLAUDE_SETTINGS_FILE_SETTING) || e.affectsConfiguration(CLAUDE_RECORD_FOLDER_SETTING)) {
				this._start();
			}
		}));
		this._start();

		// A window that stays open for weeks goes on saying which repositories it reviews
		const repositoriesTimer = this._register(new IntervalTimer());
		repositoriesTimer.cancelAndSet(() => this._writeRepositories(), 24 * 60 * 60 * 1000);
	}

	get connectionState(): ClaudeConnectionState {
		return this._connectionState;
	}

	get settingsFile(): URI {
		return this._settingsFile;
	}

	get recordFolder(): URI {
		return this._recordFolder;
	}

	private get _scriptFile(): URI {
		return joinPath(this._recordFolder, 'hook.sh');
	}

	private get _eventsFolder(): URI {
		return joinPath(this._recordFolder, 'events');
	}

	// --- the connection

	private _getLocations(): [settingsFile: URI, recordFolder: URI] {
		const userHome = this._pathService.userHome({ preferLocal: true });
		const getLocation = (setting: string, fallback: URI) => {
			const path = this._configurationService.getValue<string>(setting);
			return typeof path === 'string' && path.trim().length > 0 ? URI.file(untildify(path.trim(), userHome.fsPath)) : fallback;
		};
		return [
			getLocation(CLAUDE_SETTINGS_FILE_SETTING, joinPath(userHome, '.claude', 'settings.json')),
			getLocation(CLAUDE_RECORD_FOLDER_SETTING, joinPath(userHome, this._productService.sharedDataFolderName, 'claude-record'))
		];
	}

	private _start(): void {
		[this._settingsFile, this._recordFolder] = this._getLocations();
		this._eventsWatcher.clear();
		this._holdsWatcher.clear();
		this._readEvents.clear();
		this._records.clear();

		if (this._settingsFile.scheme !== Schemas.file) {
			this._holdsKnown.complete();
			return; // no Claude Code runs where this editor has no files of its own
		}

		this._loadHolds();

		const store = this._settingsWatcher.value = new DisposableStore();
		const watcher = store.add(this._fileService.createWatcher(this._settingsFile, { recursive: false, excludes: [] }));
		store.add(watcher.onDidChange(() => this._refreshScheduler.schedule()));
		this.refreshConnection();
	}

	refreshConnection(): Promise<ClaudeConnectionState> {
		return this._connectionSequencer.queue(async () => {
			let state = ClaudeConnectionState.NotConnected;
			try {
				const settings = await this._readText(this._settingsFile);
				if (settings !== undefined) {
					const hooks = getClaudeHooks(settings, this._scriptFile.fsPath);
					state = hooks === ClaudeHooks.Current ? ClaudeConnectionState.Connected : hooks === ClaudeHooks.Outdated ? ClaudeConnectionState.NeedsUpdate : ClaudeConnectionState.NotConnected;
				} else if (!await this._fileService.exists(dirname(this._settingsFile))) {
					state = ClaudeConnectionState.NotFound;
				}
				if (state === ClaudeConnectionState.Connected || state === ClaudeConnectionState.NeedsUpdate) {
					await this._ensureHookScript();
				}
				await this._watchEvents();
				await this._watchHolds();
			} catch (error) {
				this._logService.warn('[change review] could not look at the connection to Claude Code', error);
			}

			if (this._store.isDisposed) {
				return state;
			}
			if (state !== this._connectionState) {
				this._connectionState = state;
				this._onDidChangeConnection.fire();
				this._writeRepositories();
			}
			return state;
		});
	}

	async connect(): Promise<void> {
		if (!await this._fileService.exists(dirname(this._settingsFile))) {
			throw new ClaudeSettingsError(localize('claudeNotFound', "Claude Code has no settings folder at {0}. Start Claude Code once, then try again.", this._labelService.getUriLabel(dirname(this._settingsFile))));
		}

		await this._ensureHookScript();
		await this._updateSettings(settings => addClaudeHooks(settings, this._scriptFile.fsPath));
		await this.refreshConnection();
	}

	async disconnect(): Promise<void> {
		await this._updateSettings(settings => removeClaudeHooks(settings));
		await this.refreshConnection();
	}

	/** Every editor that is connected runs the same script. An older one is replaced, a newer one is left alone. */
	private async _ensureHookScript(): Promise<void> {
		await this._fileService.createFolder(this._eventsFolder);
		if (!isCurrentClaudeHookScript(await this._readText(this._scriptFile))) {
			await this._fileService.writeFile(this._scriptFile, VSBuffer.fromString(CLAUDE_HOOK_SCRIPT));
		}
	}

	/**
	 * Changes the settings of Claude Code in place: the file keeps its permissions, and stays a link if it is one.
	 * A change that someone else made to it meanwhile is not written over.
	 */
	private async _updateSettings(update: (settings: string) => string): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			let current: { readonly text: string; readonly etag: string; readonly mtime: number } | undefined;
			try {
				const content = await this._fileService.readFile(this._settingsFile);
				current = { text: content.value.toString(), etag: content.etag, mtime: content.mtime };
			} catch (error) {
				if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
					throw error;
				}
			}

			const updated = update(current?.text ?? '');
			if (updated === (current?.text ?? '')) {
				return;
			}

			try {
				await this._fileService.writeFile(this._settingsFile, VSBuffer.fromString(updated), current ? { etag: current.etag, mtime: current.mtime } : undefined);
				return;
			} catch (error) {
				if (attempt > 0 || toFileOperationResult(error) !== FileOperationResult.FILE_MODIFIED_SINCE) {
					throw error;
				}
			}
		}
	}

	async getLastHeard(): Promise<IClaudeLastHeard | undefined> {
		try {
			const content = await this._fileService.readFile(joinPath(this._recordFolder, 'heard'));
			return { time: content.mtime, entrypoint: content.value.toString().trim() };
		} catch {
			return undefined;
		}
	}

	private async _readText(resource: URI): Promise<string | undefined> {
		try {
			return (await this._fileService.readFile(resource)).value.toString();
		} catch (error) {
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				return undefined;
			}
			throw error;
		}
	}

	// --- events: what the script stored

	/** The folder of the events is there once the hooks were connected, by this window or by another one. */
	private async _watchEvents(): Promise<void> {
		if (this._eventsWatcher.value || !await this._fileService.exists(this._eventsFolder) || this._store.isDisposed) {
			return;
		}

		const store = this._eventsWatcher.value = new DisposableStore();
		const watcher = store.add(this._fileService.createWatcher(this._eventsFolder, { recursive: false, excludes: [] }));
		store.add(watcher.onDidChange(() => this._scanScheduler.schedule()));
		this._scanScheduler.schedule(0);
		this._sweepScheduler.schedule();
	}

	/** Reads what the script stored since the last time. One look at a time: the next one sees what came in meanwhile. */
	private _scanEvents(): Promise<void> {
		return this._scanSequencer.queue(async () => {
			if (this._store.isDisposed) {
				return;
			}
			try {
				await this._readNewEvents();
			} catch (error) {
				if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
					this._logService.warn('[change review] could not read what Claude Code reported', error);
				}
			}
		});
	}

	private async _readNewEvents(): Promise<void> {
		const eventsFolder = this._eventsFolder;
		const stat = await this._fileService.resolve(eventsFolder, { resolveMetadata: true });
		const now = Date.now();
		const names = new Set<string>();

		// In the order in which they were stored: what Claude Code staged first decides what a file is reviewed against
		for (const child of [...stat.children ?? []].sort((a, b) => a.mtime - b.mtime)) {
			if (child.isDirectory) {
				continue;
			}

			const isOld = now - child.mtime > EVENT_KEPT_MS;
			const isGitEvent = GIT_EVENT_NAME.test(child.name);
			const isGoneEvent = GONE_EVENT_NAME.test(child.name);
			if (!isGitEvent && !isGoneEvent && !EVENT_NAME.test(child.name)) {
				if (isOld && UNFINISHED_EVENT_NAME.test(child.name)) {
					await this._deleteQuietly(child.resource); // a run of the script that was stopped half way
				}
				continue;
			}

			names.add(child.name);
			if (!this._readEvents.has(child.name)) {
				this._readEvents.add(child.name);
				if (isGitEvent) {
					await this._digestGitEvent(child.resource, child.name, child.size);
				} else if (isGoneEvent) {
					await this._digestGoneEvent(child.resource, child.name, child.mtime, child.size);
				} else {
					await this._digestEvent(child.resource, child.name, child.mtime, child.size);
				}
			}
			if (isOld) {
				await this._deleteQuietly(child.resource);
			}
		}

		for (const name of this._readEvents) {
			if (!names.has(name)) {
				this._readEvents.delete(name);
			}
		}
	}

	/** Writes the entries for one event, and adds them to what is known for the files that were asked about. */
	private async _digestEvent(resource: URI, name: string, time: number, size: number): Promise<void> {
		if (size > MAX_EVENT_SIZE) {
			return;
		}

		let entries: IClaudeRecordEntry[];
		try {
			const input: unknown = JSON.parse((await this._fileService.readFile(resource)).value.toString());
			entries = digestClaudeHookInput(input, time);
		} catch {
			return; // not what Claude Code hands to a hook, or taken away by another window meanwhile
		}

		await this._storeEntries(entries, name);
	}

	/** Writes the entries for the files that a shell command of Claude Code deleted. */
	private async _digestGoneEvent(resource: URI, name: string, time: number, size: number): Promise<void> {
		if (size > MAX_EVENT_SIZE) {
			return;
		}

		let entries: IClaudeRecordEntry[];
		try {
			entries = digestClaudeGoneEvent((await this._fileService.readFile(resource)).value.toString(), time);
		} catch {
			return; // taken away by another window meanwhile
		}

		await this._storeEntries(entries, name.replace(/\.gone$/, '.json'));
	}

	/**
	 * Stores entries under a name, and adds them to what is known for the files that were asked about.
	 * @param name the name of the entry in the folder of each file. Every window writes the same one for an event.
	 */
	private async _storeEntries(entries: readonly IClaudeRecordEntry[], name: string): Promise<void> {
		for (const entry of entries) {
			try {
				await this._fileService.createFile(joinPath(this._getEntriesFolder(entry.path), name), VSBuffer.fromString(JSON.stringify(entry)), { overwrite: false });
			} catch (error) {
				if (toFileOperationResult(error) !== FileOperationResult.FILE_MODIFIED_SINCE) {
					this._logService.warn('[change review] could not store what Claude Code changed', error);
				}
				// otherwise another window has written the same entry
			}

			const record = this._records.get(entry.path);
			if (record && !record.events.has(name)) {
				record.events.add(name);
				record.entries.push(entry);
				this._onDidChangeRecord.fire(URI.file(entry.path));
			}
		}
	}

	private async _deleteQuietly(resource: URI, recursive = false): Promise<void> {
		try {
			await this._fileService.del(resource, { recursive });
		} catch {
			// gone already: another window took it away
		}
	}

	// --- entries: what is on record for a file

	private _getEntriesFolder(path: string): URI {
		const sha1 = new StringSHA1();
		sha1.update(path);
		return joinPath(this._recordFolder, 'files', sha1.digest());
	}

	getEntries(uri: URI): readonly IClaudeRecordEntry[] {
		if (uri.scheme !== Schemas.file) {
			return [];
		}

		const path = uri.fsPath;
		let record = this._records.get(path);
		if (!record) {
			record = { entries: [], events: new Set() };
			this._records.set(path, record);
			this._loadEntries(path, record);
		}
		return record.entries;
	}

	private async _loadEntries(path: string, record: IFileRecord): Promise<void> {
		let hasNewEntries = false;
		try {
			const stat = await this._fileService.resolve(this._getEntriesFolder(path), { resolveMetadata: true });
			const now = Date.now();
			await Promise.all((stat.children ?? []).map(async child => {
				if (child.isDirectory || !ENTRY_NAME.test(child.name)) {
					return;
				}
				if (now - child.mtime > ENTRY_KEPT_MS) {
					await this._deleteQuietly(child.resource);
					return;
				}

				const entry = parseClaudeRecordEntry((await this._fileService.readFile(child.resource)).value.toString());
				if (entry && entry.path === path && !record.events.has(child.name)) {
					record.events.add(child.name);
					record.entries.push(entry);
					hasNewEntries = true;
				}
			}));
		} catch (error) {
			if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
				this._logService.warn('[change review] could not read what is on record for a file', error);
			}
		}

		if (hasNewEntries && !this._store.isDisposed && this._records.get(path) === record) {
			this._onDidChangeRecord.fire(URI.file(path));
		}
	}

	// --- holds: what stays under review although Claude Code staged it

	private get _heldFolder(): URI {
		return joinPath(this._recordFolder, 'held');
	}

	private _getHashedFile(folder: string, path: string): URI {
		const sha1 = new StringSHA1();
		sha1.update(path);
		return joinPath(this._recordFolder, folder, `${sha1.digest()}.json`);
	}

	get whenHoldsKnown(): Promise<void> {
		return this._holdsKnown.p;
	}

	get holds(): readonly IClaudeHold[] {
		return [...this._holds.values()].filter(hold => hold.released === undefined);
	}

	getHold(uri: URI): IClaudeHold | undefined {
		const hold = uri.scheme === Schemas.file ? this._holds.get(uri.fsPath) : undefined;
		return hold?.released === undefined ? hold : undefined;
	}

	registerRepository(root: URI): void {
		if (root.scheme === Schemas.file && !this._repositories.has(root.fsPath)) {
			this._repositories.add(root.fsPath);
			this._writeRepositories();
		}
	}

	/** Tells the script which repositories to look at. It is only run while Claude Code is connected. */
	private async _writeRepositories(): Promise<void> {
		if (this._connectionState !== ClaudeConnectionState.Connected) {
			return;
		}
		for (const path of this._repositories) {
			try {
				const sha1 = new StringSHA1();
				sha1.update(path);
				await this._fileService.writeFile(joinPath(this._recordFolder, 'repos', sha1.digest()), VSBuffer.fromString(`${path}\n`));
			} catch (error) {
				this._logService.warn('[change review] could not note a repository for Claude Code', error);
			}
		}
	}

	/** The folder of the holds is there once Claude Code staged something, as this window or another one found. */
	private async _watchHolds(): Promise<void> {
		if (this._holdsWatcher.value || !await this._fileService.exists(this._heldFolder) || this._store.isDisposed) {
			return;
		}

		const store = this._holdsWatcher.value = new DisposableStore();
		const watcher = store.add(this._fileService.createWatcher(this._heldFolder, { recursive: false, excludes: [] }));
		store.add(watcher.onDidChange(() => this._loadHoldsScheduler.schedule()));
		this._loadHoldsScheduler.schedule(0); // what another window wrote before this one watched
	}

	/** Reads what is stored for every file, as this window and the others wrote it. */
	private _loadHolds(): Promise<void> {
		return this._holdSequencer.queue(async () => {
			const holds = new Map<string, IClaudeHold>();
			try {
				const stat = await this._fileService.resolve(this._heldFolder, { resolveMetadata: true });
				const now = Date.now();
				await Promise.all((stat.children ?? []).map(async child => {
					if (child.isDirectory || !HASHED_NAME.test(child.name)) {
						return;
					}
					const hold = parseClaudeHold((await this._fileService.readFile(child.resource)).value.toString());
					if (!hold || now - child.mtime > (hold.released === undefined ? HOLD_KEPT_MS : ENTRY_KEPT_MS)) {
						await this._deleteQuietly(child.resource);
					} else {
						holds.set(hold.path, hold);
					}
				}));
			} catch (error) {
				if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
					this._logService.warn('[change review] could not read which files are held under review', error);
				}
			}

			if (this._store.isDisposed) {
				return;
			}
			const before = this._holds;
			this._holds = holds;
			for (const path of new Set([...before.keys(), ...holds.keys()])) {
				if (getHoldSignature(before.get(path)) !== getHoldSignature(holds.get(path))) {
					this._onDidChangeHolds.fire(URI.file(path));
				}
			}
			this._holdsKnown.complete();
		});
	}

	/**
	 * Changes what is stored for a file. It is read anew for that: another window may have written it since.
	 * @param update says what to store, or `undefined` to leave what is there
	 */
	private _updateHold(path: string, update: (hold: IClaudeHold | undefined) => Promise<IClaudeHold | undefined> | IClaudeHold | undefined): Promise<void> {
		return this._holdSequencer.queue(async () => {
			const file = this._getHashedFile('held', path);
			try {
				const text = await this._readText(file);
				const stored = text !== undefined ? parseClaudeHold(text) : undefined;
				const hold = await update(stored?.path === path ? stored : undefined);
				if (!hold || this._store.isDisposed) {
					return;
				}

				await this._fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(hold)));
				const before = this._holds.get(path);
				this._holds.set(path, hold);
				if (getHoldSignature(before) !== getHoldSignature(hold)) {
					this._onDidChangeHolds.fire(URI.file(path));
				}
			} catch (error) {
				this._logService.warn('[change review] could not store that a file is held under review', error);
			}
		});
	}

	/** Takes what a shell command of Claude Code staged into what is stored for the files it staged. */
	private async _digestGitEvent(resource: URI, name: string, size: number): Promise<void> {
		if (size > MAX_EVENT_SIZE) {
			return;
		}

		let stagings: IClaudeStaging[];
		try {
			const event = parseClaudeGitEvent((await this._fileService.readFile(resource)).value.toString());
			stagings = event ? getClaudeStagings(event) : [];
		} catch {
			return; // taken away by another window meanwhile
		}

		for (const staging of stagings) {
			await this._updateHold(staging.path, async hold => applyClaudeStaging(hold, staging, name, await this._readOwnStaging(staging.path)));
		}
		if (stagings.length > 0) {
			await this._watchHolds();
		}
	}

	setHoldReviewed(uri: URI, blob: string): Promise<void> {
		return this._updateHold(uri.fsPath, hold => {
			if (!hold || hold.released !== undefined || hold.reviewed === blob) {
				return undefined;
			}
			const original = hold.original ?? hold.reviewed ?? undefined;
			return { ...hold, reviewed: blob, ...(original !== undefined ? { original } : {}) };
		});
	}

	releaseHold(uri: URI): Promise<void> {
		return this._updateHold(uri.fsPath, hold => hold && hold.released === undefined ? { ...hold, released: Date.now() } : undefined);
	}

	async noteOwnStaging(uri: URI, blob: string): Promise<void> {
		// Only while Claude Code is connected: without its hooks nothing is ever compared with this
		if (uri.scheme !== Schemas.file || this._connectionState !== ClaudeConnectionState.Connected) {
			return;
		}
		try {
			const own: IOwnStaging = { blob, time: Date.now() };
			await this._fileService.writeFile(this._getHashedFile('own', uri.fsPath), VSBuffer.fromString(JSON.stringify(own)));
		} catch (error) {
			this._logService.warn('[change review] could not note what was staged here', error);
		}
	}

	private async _readOwnStaging(path: string): Promise<IOwnStaging | undefined> {
		try {
			const text = await this._readText(this._getHashedFile('own', path));
			return text !== undefined ? parseOwnStaging(text) : undefined;
		} catch {
			return undefined;
		}
	}

	async settle(file: URI): Promise<boolean> {
		if (file.scheme !== Schemas.file) {
			return false;
		}
		// In this order: the script stores what a command staged before it takes away what it noted before the
		// command. So a command that is not running anymore has stored all it has by the time that is looked at.
		const isRunning = await this._isCommandRunning(file.fsPath);
		await this._scanEvents();
		await this._holdSequencer.queue(async () => { });
		return isRunning;
	}

	/** Whether the script noted the staged versions of the repository of a file before a shell command that has not ended. */
	private async _isCommandRunning(path: string): Promise<boolean> {
		try {
			const stat = await this._fileService.resolve(joinPath(this._recordFolder, 'pending'), { resolveMetadata: true });
			const now = Date.now();
			for (const snapshot of stat.children ?? []) {
				if (!snapshot.isDirectory || now - snapshot.mtime > SNAPSHOT_KEPT_MS) {
					continue;
				}
				const files = await this._fileService.resolve(snapshot.resource);
				for (const file of files.children ?? []) {
					const repository = file.name.endsWith('.repo') ? (await this._readText(file.resource))?.split('\n')[0] : undefined;
					if (repository && (path === repository || path.startsWith(repository + sep))) {
						return true;
					}
				}
			}
		} catch {
			// nothing noted, or taken away meanwhile: the command is over
		}
		return false;
	}

	/** Takes away what is on record for files that Claude Code has not changed for a long time. */
	private async _sweepEntries(): Promise<void> {
		try {
			const stat = await this._fileService.resolve(joinPath(this._recordFolder, 'files'), { resolveMetadata: true });
			const now = Date.now();
			for (const child of stat.children ?? []) {
				// A folder is as old as the last entry that was put into it
				if (child.isDirectory && ENTRIES_FOLDER_NAME.test(child.name) && now - child.mtime > ENTRY_KEPT_MS) {
					await this._deleteQuietly(child.resource, true);
				}
			}
		} catch {
			// nothing on record yet
		}

		for (const [folder, keptFor] of [['repos', REPOSITORY_KEPT_MS], ['own', ENTRY_KEPT_MS]] as const) {
			try {
				const stat = await this._fileService.resolve(joinPath(this._recordFolder, folder), { resolveMetadata: true });
				const now = Date.now();
				for (const child of stat.children ?? []) {
					if (!child.isDirectory && HASHED_NAME.test(child.name) && now - child.mtime > keptFor) {
						await this._deleteQuietly(child.resource);
					}
				}
			} catch {
				// nothing noted yet
			}
		}
	}
}
