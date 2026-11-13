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

import { RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { untildify } from '../../../../base/common/labels.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { addClaudeHooks, CLAUDE_HOOK_SCRIPT, CLAUDE_RECORD_FOLDER_SETTING, CLAUDE_SETTINGS_FILE_SETTING, ClaudeConnectionState, ClaudeSettingsError, digestClaudeHookInput, hasClaudeHooks, IClaudeLastHeard, IClaudeRecordEntry, IClaudeRecordService, isCurrentClaudeHookScript, parseClaudeRecordEntry, removeClaudeHooks } from '../common/claudeRecord.js';

/** How long an event is kept after the script stored it. Every open window reads it within a moment. */
const EVENT_KEPT_MS = 10 * 60 * 1000;
/** How long an entry is kept. A change that is still not reviewed by then is shown as before, without its mark. */
const ENTRY_KEPT_MS = 14 * 24 * 60 * 60 * 1000;
/** An event holds the file a tool wrote, up to three times. Larger ones are not read. */
const MAX_EVENT_SIZE = 32 * 1024 * 1024;

// Only what has one of these names is ever deleted, wherever a setting points the folder of the record
const EVENT_NAME = /^\d+-\d+\.json$/;
const UNFINISHED_EVENT_NAME = /^\.\d+\.tmp$/;
const ENTRIES_FOLDER_NAME = /^[0-9a-f]{40}$/;

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
	private _isScanning = false;
	private _needsScan = false;
	/** The events this window has read. */
	private readonly _readEvents = new Set<string>();
	private readonly _sweepScheduler = this._register(new RunOnceScheduler(() => this._sweepEntries(), 60_000));

	/** What is on record for the files that were asked about, by path. */
	private readonly _records = new Map<string, IFileRecord>();

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
		this._readEvents.clear();
		this._records.clear();

		if (this._settingsFile.scheme !== Schemas.file) {
			return; // no Claude Code runs where this editor has no files of its own
		}

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
					state = hasClaudeHooks(settings, this._scriptFile.fsPath) ? ClaudeConnectionState.Connected : ClaudeConnectionState.NotConnected;
				} else if (!await this._fileService.exists(dirname(this._settingsFile))) {
					state = ClaudeConnectionState.NotFound;
				}
				if (state === ClaudeConnectionState.Connected) {
					await this._ensureHookScript();
				}
				await this._watchEvents();
			} catch (error) {
				this._logService.warn('[change review] could not look at the connection to Claude Code', error);
			}

			if (this._store.isDisposed) {
				return state;
			}
			if (state !== this._connectionState) {
				this._connectionState = state;
				this._onDidChangeConnection.fire();
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

	private async _scanEvents(): Promise<void> {
		if (this._isScanning) {
			this._needsScan = true; // more came in while the last ones are read: once more after that
			return;
		}

		this._isScanning = true;
		try {
			do {
				this._needsScan = false;
				await this._readNewEvents();
			} while (this._needsScan && !this._store.isDisposed);
		} catch (error) {
			this._logService.warn('[change review] could not read what Claude Code reported', error);
		} finally {
			this._isScanning = false;
		}
	}

	private async _readNewEvents(): Promise<void> {
		const eventsFolder = this._eventsFolder;
		const stat = await this._fileService.resolve(eventsFolder, { resolveMetadata: true });
		const now = Date.now();
		const names = new Set<string>();

		for (const child of stat.children ?? []) {
			if (child.isDirectory) {
				continue;
			}

			const isOld = now - child.mtime > EVENT_KEPT_MS;
			if (!EVENT_NAME.test(child.name)) {
				if (isOld && UNFINISHED_EVENT_NAME.test(child.name)) {
					await this._deleteQuietly(child.resource); // a run of the script that was stopped half way
				}
				continue;
			}

			names.add(child.name);
			if (!this._readEvents.has(child.name)) {
				this._readEvents.add(child.name);
				await this._digestEvent(child.resource, child.name, child.mtime, child.size);
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
				if (child.isDirectory || !EVENT_NAME.test(child.name)) {
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
	}
}
