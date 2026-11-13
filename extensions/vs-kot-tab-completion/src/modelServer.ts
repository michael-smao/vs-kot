/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the model server that the editor installs and runs itself, so that tab completion works without
// anyone installing anything by hand. It is the official Ollama build for macOS, downloaded once into the
// editor's own folder, started in the background when needed, and reachable from this computer only.

import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** The pinned build of the model server. The checksum is the one GitHub publishes for the release file. */
const RUNTIME = {
	version: '0.40.16',
	url: 'https://github.com/ollama/ollama/releases/download/v0.40.16/ollama-darwin.tgz',
	sha256: 'a743717494315da7cd352982b805f6b992d4b4452ca117fd5fbf86c4ee46fca0',
	downloadSize: 186_000_000
};

/** A port of its own, so that it never gets in the way of an Ollama someone installed themselves. */
const DEFAULT_PORT = 11535;

/**
 * Raised whenever the way the server is started changes, such as its settings below. A server that an older
 * build of the editor left running is then replaced instead of used as it is.
 */
const LAUNCH_VERSION = 2;

/** Where the downloads were kept while the editor had its former name. They are taken over, not downloaded again. */
const LEGACY_ROOT = path.join(os.homedir(), '.vs-claude', 'tab-completion');

/**
 * The model the editor uses unless another one is set: Qwen2.5-Coder 7B in its base variant. Qwen names the base
 * models, not the "instruct" ones that Ollama's plain tags such as `qwen2.5-coder:7b` stand for, as the ones for
 * completion and fill-in, and on real code the base variant completes more lines exactly as they were written.
 * Under the Apache 2.0 license.
 */
const DEFAULT_MODEL = 'qwen2.5-coder:7b-base';
/** What a Mac with little memory gets instead: the same model family at a fifth of the size. */
const MODEL_FOR_SMALL_MEMORY = 'qwen2.5-coder:1.5b-base';
/** Below this, the 7B model (about 5.5 GB in memory) leaves too little room for everything else. */
const SMALL_MEMORY_BYTES = 16 * 1024 ** 3;
/** Download sizes of the models that are worth choosing, to say beforehand how much setting up downloads. */
const KNOWN_MODEL_SIZES: Record<string, number> = {
	'qwen2.5-coder:7b-base': 4_700_000_000,
	'qwen2.5-coder:1.5b-base': 1_000_000_000,
	'qwen2.5-coder:1.5b-base-q8_0': 1_600_000_000,
	'qwen2.5-coder:7b': 4_700_000_000,
	'qwen2.5-coder:1.5b': 1_000_000_000
};
/**
 * How many tokens the model server makes room for. Left to itself, Ollama picks this by the memory of the computer,
 * from 4,096 on small ones, where a long prompt would be cut off at its start, up to all the model can take. A
 * fixed size makes every computer behave the same. 8,192 is the length Qwen trained fill-in on single files with,
 * and holds the longest prompt the editor sends with room to spare.
 */
export const CONTEXT_TOKENS = 8192;
/** Room that has to be left on the disk after a model is downloaded. */
const MODEL_DISK_HEADROOM_BYTES = 3 * 1024 ** 3;
/** What the model server takes on the disk while it is installed: its archive and what is unpacked from it. */
const RUNTIME_DISK_BYTES = 1024 ** 3;

/** The model server writes several lines per suggestion. Its log is emptied when it gets this large. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const LOG_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** The model server drops a model from memory after this long without a request. A little before that, it is asked to load it again. */
const KEEP_ALIVE = '30m';
const RELOAD_AFTER_IDLE_MS = 25 * 60 * 1000;

/** What is written next to the downloads about the server that runs. */
interface IServerDescriptor {
	readonly pid: number;
	readonly runtime: string;
	readonly launch: number;
}

/**
 * How much memory the model runner may use to keep prompts it has read, in MiB. With such a prompt at hand it
 * answers at once in a place the user comes back to. Left alone it takes up to 8 GB for that, whatever the
 * computer has: on a 16 GB Mac that is more than the model itself.
 */
function getPromptCacheMegabytes(): number {
	return Math.max(256, Math.min(2048, Math.round(os.totalmem() / (32 * 1024 * 1024))));
}

/** A model server behind a proxy needs to know about it to download a model. Nothing else of the environment is passed on. */
function getProxyEnvironment(): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy', 'SSL_CERT_FILE']) {
		const value = process.env[name];
		if (value) {
			result[name] = value;
		}
	}
	return result;
}

export type ServerState =
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'needsSetup' }
	| { readonly kind: 'settingUp'; readonly step: string; readonly percent: number | undefined }
	| { readonly kind: 'starting' }
	| { readonly kind: 'ready' }
	| { readonly kind: 'stopped' }
	| { readonly kind: 'failed'; readonly message: string };

export class ManagedModelServer implements vscode.Disposable {

	readonly endpoint: string;
	private readonly _port: number;

	private readonly _onDidChangeState = new vscode.EventEmitter<ServerState>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private _state: ServerState;
	private _operation: Promise<void> | undefined;

	private readonly _root: string;
	private readonly _isRootFromEnvironment: boolean;
	private readonly _logTimer: ReturnType<typeof setInterval>;

	/** When the model last answered or was loaded, to know when the model server has dropped it from memory. */
	private _lastUse = 0;
	private _loading: Promise<void> | undefined;

	constructor(private readonly _log: vscode.LogOutputChannel) {
		// A fixed folder in the home directory: the source build, the installed app and every profile share one download.
		// Tests point both the folder and the port somewhere else, to run a server of their own next to the real one.
		const root = process.env['VS_KOT_TAB_COMPLETION_HOME'];
		this._isRootFromEnvironment = !!root;
		this._root = root || path.join(os.homedir(), '.vs-kot', 'tab-completion');
		this._port = Number(process.env['VS_KOT_TAB_COMPLETION_PORT']) || DEFAULT_PORT;
		this.endpoint = `http://127.0.0.1:${this._port}`;
		this._state = process.platform === 'darwin' && process.arch === 'arm64' ? { kind: 'needsSetup' } : { kind: 'unsupported' };

		this._logTimer = setInterval(() => this._trimLog(), LOG_CHECK_INTERVAL_MS);
		this._logTimer.unref();
	}

	dispose(): void {
		clearInterval(this._logTimer);
		this._onDidChangeState.dispose();
	}

	get state(): ServerState {
		return this._state;
	}

	/** The model in use: the configured one, or else the default, or its small sibling on a Mac with little memory. */
	get model(): string {
		const configured = vscode.workspace.getConfiguration('tabCompletion').get<string>('model', '').trim();
		if (configured) {
			return configured;
		}
		return os.totalmem() < SMALL_MEMORY_BYTES ? MODEL_FOR_SMALL_MEMORY : DEFAULT_MODEL;
	}

	/** How much setting up still has to download, in bytes. `undefined` when the size of the model is not known. */
	async getPendingDownloadSize(): Promise<number | undefined> {
		const modelSize = KNOWN_MODEL_SIZES[this.model];
		return modelSize === undefined ? undefined : modelSize + (await this._isInstalled() ? 0 : RUNTIME.downloadSize);
	}

	private get _runtimeDir(): string {
		return path.join(this._root, 'runtime', RUNTIME.version);
	}

	private get _binary(): string {
		return path.join(this._runtimeDir, 'ollama');
	}

	private _isInstalled(): Promise<boolean> {
		return exists(this._binary);
	}

	private _setState(state: ServerState): void {
		this._state = state;
		this._onDidChangeState.fire(state);
	}

	/**
	 * Brings the server up if everything it needs is already on this computer. Downloads no model, and the model
	 * server only when a newer build of the editor asks for another version of it than the one that is installed.
	 */
	initialize(): Promise<void> {
		return this._run(async () => {
			if (this._state.kind === 'unsupported') {
				return;
			}

			await this._adoptLegacyFolder();
			if (!await this._isInstalled()) {
				if (!await this._hasOtherRuntime()) {
					this._setState({ kind: 'needsSetup' });
					return;
				}
				await this._checkDiskSpace(RUNTIME_DISK_BYTES);
				await this._installRuntime(new AbortController().signal);
			}
			if (await exists(this._stoppedFile)) {
				this._setState({ kind: 'stopped' }); // someone stopped it on purpose: it stays stopped in every window
				return;
			}

			const started = Date.now();
			this._setState({ kind: 'starting' });
			await this._start();
			if (!await this._hasModel()) {
				this._setState({ kind: 'needsSetup' });
				return;
			}
			await this._loadModel();
			this._log.debug(`The model server and the model ${this.model} were ready after ${Date.now() - started} ms.`);
			this._setState({ kind: 'ready' });
		});
	}

	/**
	 * Downloads what is missing, starts the server and loads the model.
	 * @returns whether tab completion is ready afterwards. `false` also when the user cancelled.
	 */
	async setUp(token: vscode.CancellationToken): Promise<boolean> {
		await this._run(async () => {
			if (this._state.kind === 'unsupported') {
				return;
			}

			const abort = new AbortController();
			const cancellation = token.onCancellationRequested(() => abort.abort());
			try {
				await this._adoptLegacyFolder();
				await fs.promises.rm(this._stoppedFile, { force: true });
				if (!await this._isInstalled()) {
					await this._checkDiskSpace(RUNTIME_DISK_BYTES);
					await this._installRuntime(abort.signal);
				}
				this._setState({ kind: 'settingUp', step: vscode.l10n.t('Starting the model server'), percent: undefined });
				await this._start();
				if (!await this._hasModel()) {
					const modelSize = KNOWN_MODEL_SIZES[this.model];
					if (modelSize !== undefined) {
						await this._checkDiskSpace(modelSize + MODEL_DISK_HEADROOM_BYTES);
					}
					await this._downloadModel(abort.signal);
				}
				this._setState({ kind: 'settingUp', step: vscode.l10n.t('Loading the model'), percent: undefined });
				await this._loadModel();
				this._setState({ kind: 'ready' });
			} catch (error) {
				if (token.isCancellationRequested) {
					this._log.info('Setup cancelled. A model that was downloaded in part is continued next time.');
					this._setState({ kind: 'needsSetup' });
					return;
				}
				throw error;
			} finally {
				cancellation.dispose();
			}
		});
		return this._state.kind === 'ready';
	}

	/**
	 * Stops the server, for all windows. It stays stopped until it is started through {@link setUp}:
	 * a window that is typed in does not bring it back.
	 */
	async stop(): Promise<void> {
		await this._run(async () => {
			await fs.promises.mkdir(this._root, { recursive: true });
			await fs.promises.writeFile(this._stoppedFile, '');

			const pid = await this._getServerPid(this._root);
			if (pid !== undefined) {
				await this._kill(pid);
				this._log.info(`Stopped the model server (process ${pid}).`);
			}
			await fs.promises.rm(this._descriptorFile, { force: true });
			await fs.promises.rm(path.join(this._root, 'server.pid'), { force: true });
			await this._endOrphanedRunners(path.join(this._root, 'models'));

			if (this._state.kind === 'ready' || this._state.kind === 'starting') {
				this._setState({ kind: 'stopped' });
			}
		});
	}

	/**
	 * Called before a suggestion is asked for. After a long pause the model server has dropped the model from
	 * memory. Loading it takes seconds, and a request that typing cancels must not be what it hangs on.
	 */
	async prepare(): Promise<void> {
		if (this._state.kind !== 'ready' || Date.now() - this._lastUse < RELOAD_AFTER_IDLE_MS) {
			return;
		}
		this._loading ??= this._loadModel().catch(error => {
			this._log.warn(`The model could not be loaded again: ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => {
			this._loading = undefined;
		});
		await this._loading;
	}

	/** The model just answered. */
	noteUse(): void {
		this._lastUse = Date.now();
	}

	/** One thing at a time, and a failure ends up in the state instead of being lost. */
	private _run(operation: () => Promise<void>): Promise<void> {
		const previous = this._operation ?? Promise.resolve();
		const next = previous.then(operation).catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this._log.error(message);
			this._setState({ kind: 'failed', message });
		});
		this._operation = next;
		return next;
	}

	// --- installing

	private async _checkDiskSpace(needed: number): Promise<void> {
		await fs.promises.mkdir(this._root, { recursive: true });
		const stats = await fs.promises.statfs(this._root);
		const free = stats.bavail * stats.bsize;
		if (free < needed) {
			throw new Error(vscode.l10n.t('Not enough free disk space: {0} GB are needed, {1} GB are free.', toGigabytes(needed), toGigabytes(free)));
		}
	}

	/** Whether another version of the model server is installed than the one this build of the editor asks for. */
	private async _hasOtherRuntime(): Promise<boolean> {
		for (const version of await this._getOtherRuntimes()) {
			if (await exists(path.join(this._root, 'runtime', version, 'ollama'))) {
				return true;
			}
		}
		return false;
	}

	private async _getOtherRuntimes(): Promise<string[]> {
		try {
			const entries = await fs.promises.readdir(path.join(this._root, 'runtime'), { withFileTypes: true });
			return entries.filter(entry => entry.isDirectory() && entry.name !== RUNTIME.version && !entry.name.endsWith('.part')).map(entry => entry.name);
		} catch {
			return [];
		}
	}

	/**
	 * The downloads of the editor under its former name become this editor's: a few gigabytes that nobody should
	 * have to fetch twice. A server that still runs from there is stopped first, since it would lose its files.
	 */
	private async _adoptLegacyFolder(): Promise<void> {
		if (this._isRootFromEnvironment || await exists(this._root) || !await exists(LEGACY_ROOT)) {
			return;
		}

		try {
			const pid = await this._getServerPid(LEGACY_ROOT);
			if (pid !== undefined) {
				await this._kill(pid);
			}
			await fs.promises.mkdir(path.dirname(this._root), { recursive: true });
			await fs.promises.rename(LEGACY_ROOT, this._root);
			await fs.promises.rm(path.join(this._root, 'server.pid'), { force: true });
			// An editor of the former name may still be open, or be started again: it finds everything through this link,
			// and uses the server that is started from here
			await fs.promises.symlink(this._root, LEGACY_ROOT).catch(() => undefined);
			this._log.info(`Took over the downloads from ${LEGACY_ROOT}.`);
		} catch (error) {
			this._log.warn(`Could not take over the downloads from ${LEGACY_ROOT}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async _installRuntime(signal: AbortSignal): Promise<void> {
		const step = vscode.l10n.t('Downloading the model server');
		this._setState({ kind: 'settingUp', step, percent: 0 });
		this._log.info(`Downloading ${RUNTIME.url}`);

		const downloadDir = path.join(this._root, 'runtime');
		await fs.promises.mkdir(downloadDir, { recursive: true });
		await this._removeLeftoverDownloads(downloadDir);
		// Names of its own per window, so that two windows that set up at the same time don't write into each other's files
		const archive = path.join(downloadDir, `${RUNTIME.version}.${process.pid}.tgz.part`);
		const extractDir = path.join(downloadDir, `${RUNTIME.version}.${process.pid}.part`);

		try {
			const response = await fetch(RUNTIME.url, { signal, redirect: 'follow' });
			if (!response.ok || !response.body) {
				throw new Error(vscode.l10n.t('The model server could not be downloaded: {0}', `${response.status} ${response.statusText}`));
			}
			const total = Number(response.headers.get('content-length')) || RUNTIME.downloadSize;
			const hash = crypto.createHash('sha256');
			// Written piece by piece, each one awaited: a full disk ends the download with an error instead of leaving it waiting
			const file = await fs.promises.open(archive, 'w');
			let received = 0;
			try {
				const reader = response.body.getReader();
				for (; ;) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					hash.update(value);
					received += value.byteLength;
					await file.write(value);
					this._setState({ kind: 'settingUp', step, percent: Math.min(100, Math.floor(received / total * 100)) });
				}
			} finally {
				await file.close();
			}

			// Only what is exactly the pinned release file gets unpacked and run
			if (hash.digest('hex') !== RUNTIME.sha256) {
				throw new Error(vscode.l10n.t('The downloaded model server is not the expected file. Nothing was installed.'));
			}

			this._setState({ kind: 'settingUp', step: vscode.l10n.t('Unpacking the model server'), percent: undefined });
			await fs.promises.mkdir(extractDir, { recursive: true });
			await execFile('/usr/bin/tar', ['-xzf', archive, '-C', extractDir]);
			if (!await this._isInstalled()) { // unless another window was faster
				await fs.promises.rm(this._runtimeDir, { recursive: true, force: true });
				await fs.promises.rename(extractDir, this._runtimeDir);
			}
			this._log.info(`Installed the model server ${RUNTIME.version} in ${this._runtimeDir}`);
		} finally {
			// Whether it worked, failed or was cancelled: nothing half-done stays behind
			await fs.promises.rm(archive, { force: true });
			await fs.promises.rm(extractDir, { recursive: true, force: true });
		}
	}

	/** What an earlier download left behind when the editor was closed in the middle of it. */
	private async _removeLeftoverDownloads(downloadDir: string): Promise<void> {
		try {
			for (const name of await fs.promises.readdir(downloadDir)) {
				const file = path.join(downloadDir, name);
				if (name.endsWith('.part') && Date.now() - (await fs.promises.stat(file)).mtimeMs > 60 * 60 * 1000) {
					await fs.promises.rm(file, { recursive: true, force: true });
				}
			}
		} catch {
			// nothing to clean up
		}
	}

	private async _downloadModel(signal: AbortSignal): Promise<void> {
		const model = this.model;
		const step = vscode.l10n.t('Downloading the model {0}', model);
		this._setState({ kind: 'settingUp', step, percent: 0 });
		this._log.info(`Downloading the model ${model}`);

		const response = await fetch(`${this.endpoint}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal });
		if (!response.ok || !response.body) {
			throw new Error(vscode.l10n.t('The model {0} could not be downloaded: {1}', model, `${response.status} ${response.statusText}`));
		}

		// The server reports progress per part of the model, one JSON object per line
		const parts = new Map<string, { total: number; completed: number }>();
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let pending = '';
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			pending += decoder.decode(value, { stream: true });
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}
				const event: { error?: string; digest?: string; total?: number; completed?: number } = JSON.parse(line);
				if (event.error) {
					throw new Error(vscode.l10n.t('The model {0} could not be downloaded: {1}', model, event.error));
				}
				if (event.digest && event.total) {
					parts.set(event.digest, { total: event.total, completed: event.completed ?? 0 });
					let total = 0;
					let completed = 0;
					for (const part of parts.values()) {
						total += part.total;
						completed += part.completed;
					}
					this._setState({ kind: 'settingUp', step, percent: Math.min(100, Math.floor(completed / total * 100)) });
				}
			}
		}

		if (!await this._hasModel()) {
			throw new Error(vscode.l10n.t('The model {0} could not be downloaded.', model));
		}
	}

	// --- running

	private get _descriptorFile(): string {
		return path.join(this._root, 'server.json');
	}

	/** Present while the server is stopped on purpose. */
	private get _stoppedFile(): string {
		return path.join(this._root, 'stopped');
	}

	private get _logFile(): string {
		return path.join(this._root, 'server.log');
	}

	private async _readDescriptor(root: string): Promise<IServerDescriptor | undefined> {
		try {
			const descriptor: Partial<IServerDescriptor> = JSON.parse(await fs.promises.readFile(path.join(root, 'server.json'), 'utf8'));
			if (typeof descriptor.pid === 'number' && typeof descriptor.runtime === 'string' && typeof descriptor.launch === 'number') {
				return { pid: descriptor.pid, runtime: descriptor.runtime, launch: descriptor.launch };
			}
		} catch {
			// no server was started from here, or by a build that wrote only the process id
		}
		try {
			const pid = Number(await fs.promises.readFile(path.join(root, 'server.pid'), 'utf8'));
			return Number.isInteger(pid) && pid > 0 ? { pid, runtime: '', launch: 1 } : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The process of the server that was started from a folder, if it still runs. A process id in a file can be
	 * that of something else by now, after a restart of the computer: only a process that is this model server counts.
	 */
	private async _getServerPid(root: string): Promise<number | undefined> {
		const descriptor = await this._readDescriptor(root);
		if (!descriptor) {
			return undefined;
		}
		try {
			const command = (await execFileOutput('/bin/ps', ['-o', 'command=', '-p', String(descriptor.pid)])).trim();
			return command.startsWith(path.join(root, 'runtime') + path.sep) && command.endsWith('ollama serve') ? descriptor.pid : undefined;
		} catch {
			return undefined; // no such process
		}
	}

	/** Ends a process and waits until the port is free again. */
	private async _kill(pid: number): Promise<void> {
		try {
			process.kill(pid);
		} catch {
			return; // it was gone already
		}
		for (let attempt = 0; attempt < 50; attempt++) {
			if (await this._getRunningVersion() === undefined) {
				return;
			}
			await new Promise<void>(resolve => setTimeout(resolve, 100));
		}
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// gone in the meantime
		}
		await new Promise<void>(resolve => setTimeout(resolve, 300));
	}

	/** The version of the model server that answers on the port, or `undefined` when none does. */
	private async _getRunningVersion(): Promise<string | undefined> {
		try {
			const response = await fetch(`${this.endpoint}/api/version`, { signal: AbortSignal.timeout(1500) });
			if (!response.ok) {
				return undefined;
			}
			const result = await response.json() as { version?: string };
			return typeof result.version === 'string' ? result.version : '';
		} catch {
			return undefined;
		}
	}

	/**
	 * Starts the server unless the right one runs already. It is started on its own, not as a child of this window:
	 * other windows use it too, and it needs next to nothing while nobody types.
	 */
	private async _start(): Promise<void> {
		const running = await this._getRunningVersion();
		if (running !== undefined) {
			const descriptor = await this._readDescriptor(this._root);
			const pid = await this._getServerPid(this._root);
			if (pid !== undefined && descriptor?.runtime === RUNTIME.version && descriptor.launch >= LAUNCH_VERSION) {
				return; // ours, and started the way this build starts it
			}
			if (pid !== undefined) {
				this._log.info(`Replacing the model server that an older version of the editor started (process ${pid}).`);
				await this._kill(pid);
			} else if (running === RUNTIME.version) {
				// The same model server, but nothing says who started it and how. Usable, so it is used.
				this._log.warn(`Using a model server on ${this.endpoint} that this editor did not start. Its settings may differ.`);
				return;
			} else {
				throw new Error(vscode.l10n.t('Another program uses port {0}, which tab completion needs for its model server.', this._port));
			}
		}

		const modelsDir = path.join(this._root, 'models');
		await fs.promises.mkdir(modelsDir, { recursive: true });
		await this._endOrphanedRunners(modelsDir);

		// A server that ends right after its start is started once more: the process before it may still have held the port
		for (let attempt = 1; ; attempt++) {
			const started = Date.now();
			const child = await this._spawn(modelsDir);
			const isOwn = await this._waitUntilUp(child);
			if (isOwn !== undefined) {
				this._log.debug(`The model server answered ${Date.now() - started} ms after its start.`);
				if (isOwn && child.pid !== undefined) {
					const descriptor: IServerDescriptor = { pid: child.pid, runtime: RUNTIME.version, launch: LAUNCH_VERSION };
					await fs.promises.writeFile(this._descriptorFile, JSON.stringify(descriptor));
					await fs.promises.rm(path.join(this._root, 'server.pid'), { force: true });
					this._log.info(`Started the model server (process ${child.pid}) on ${this.endpoint}`);
					await this._removeOtherRuntimes();
				} else {
					this._log.info(`Using the model server that another window started on ${this.endpoint}`);
				}
				return;
			}
			if (attempt === 3) {
				throw new Error(vscode.l10n.t('The model server did not start. See {0}.', this._logFile));
			}
			this._log.warn(`The model server ended right after its start (attempt ${attempt}). Starting it again.`);
		}
	}

	private async _spawn(modelsDir: string): Promise<cp.ChildProcess> {
		// A new log per start. The one before is kept, to look at after a crash.
		await fs.promises.rename(this._logFile, `${this._logFile}.old`).catch(() => undefined);
		const logFile = await fs.promises.open(this._logFile, 'a');
		try {
			const child = cp.spawn(this._binary, ['serve'], {
				detached: true,
				stdio: ['ignore', logFile.fd, logFile.fd],
				env: {
					HOME: os.homedir(),
					PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
					TMPDIR: os.tmpdir(),
					...getProxyEnvironment(),
					OLLAMA_HOST: `127.0.0.1:${this._port}`,
					OLLAMA_MODELS: modelsDir,
					OLLAMA_KEEP_ALIVE: KEEP_ALIVE,
					OLLAMA_NO_CLOUD: '1',
					// The same for every request and on every computer, whatever a request leaves out
					OLLAMA_CONTEXT_LENGTH: String(CONTEXT_TOKENS),
					// One request at a time, so that all of the context belongs to it, and one model in memory:
					// after a switch to another model the one before is not kept for another half hour
					OLLAMA_NUM_PARALLEL: '1',
					OLLAMA_MAX_LOADED_MODELS: '1',
					// Read by the model runner that the server starts
					LLAMA_ARG_CACHE_RAM: String(getPromptCacheMegabytes())
				}
			});
			child.on('error', error => this._log.error(`The model server could not be started: ${error.message}`));
			child.unref();
			return child;
		} finally {
			await logFile.close();
		}
	}

	/**
	 * Waits for a server to answer on the port after one was started.
	 * @returns whether the server that answers is the one that was started, or `undefined` when none answers:
	 * the started one has ended, and no other window's has taken its place
	 */
	private async _waitUntilUp(child: cp.ChildProcess): Promise<boolean | undefined> {
		let endedAt: number | undefined;
		for (let attempt = 0; attempt < 150; attempt++) {
			if (await this._getRunningVersion() !== undefined) {
				// Several windows may have tried at the same moment. The port lets only one of them through. The
				// processes of the others end within a moment: wait for that before saying whose it is.
				await new Promise<void>(resolve => setTimeout(resolve, 400));
				if (child.exitCode === null && child.signalCode === null) {
					return true;
				}
				if (await this._getRunningVersion() !== undefined) {
					return false;
				}
			}
			if (child.exitCode !== null || child.signalCode !== null) {
				// Ended, by itself or by someone's hand. Another window's server may be about to answer: give it a moment.
				endedAt ??= Date.now();
				if (Date.now() - endedAt > 1500) {
					return undefined;
				}
			}
			await new Promise<void>(resolve => setTimeout(resolve, 100));
		}
		return undefined;
	}

	/**
	 * A model runner whose server ended without stopping it keeps the model in memory, for nobody: gigabytes that
	 * would be taken a second time by the next server. Such a runner has no parent anymore and serves a model from
	 * this folder.
	 */
	private async _endOrphanedRunners(modelsDir: string): Promise<void> {
		try {
			const processes = await execFileOutput('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
			for (const line of processes.split('\n')) {
				const match = /^\s*(?<pid>\d+)\s+(?<parent>\d+)\s+(?<command>.*)$/.exec(line);
				const command = match?.groups?.command ?? '';
				if (match?.groups?.parent === '1' && /\/llama-server\s/.test(command) && command.includes(`--model ${modelsDir}${path.sep}`)) {
					this._log.info(`Ending a model runner that its server left behind (process ${match.groups.pid}).`);
					try {
						process.kill(Number(match.groups.pid));
					} catch {
						// gone in the meantime
					}
				}
			}
		} catch (error) {
			this._log.debug(`Could not look for model runners that were left behind: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Versions of the model server that no build asks for anymore take 600 MB each. */
	private async _removeOtherRuntimes(): Promise<void> {
		for (const version of await this._getOtherRuntimes()) {
			await fs.promises.rm(path.join(this._root, 'runtime', version), { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** The server has the log open for appending, so emptying it under its hands is safe. */
	private async _trimLog(): Promise<void> {
		try {
			if ((await fs.promises.stat(this._logFile)).size > MAX_LOG_BYTES) {
				await fs.promises.truncate(this._logFile, 0);
			}
		} catch {
			// no log yet
		}
	}

	private async _hasModel(): Promise<boolean> {
		const response = await fetch(`${this.endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
		if (!response.ok) {
			return false;
		}
		const tags = await response.json() as { models?: { name: string }[] };
		return (tags.models ?? []).some(model => model.name === this.model);
	}

	/**
	 * Loads the model into memory, so that the first suggestion does not have to wait for that. With the same
	 * context size as the suggestions ask for: the model server loads a model anew when that size changes.
	 */
	private async _loadModel(): Promise<void> {
		const response = await fetch(`${this.endpoint}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.model, keep_alive: KEEP_ALIVE, options: { num_ctx: CONTEXT_TOKENS } }), signal: AbortSignal.timeout(120_000) });
		if (!response.ok) {
			throw new Error(vscode.l10n.t('The model {0} could not be loaded: {1}', this.model, (await response.text()).slice(0, 200)));
		}
		await response.arrayBuffer();
		this._lastUse = Date.now();
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.promises.access(file);
		return true;
	} catch {
		return false;
	}
}

function execFile(file: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		cp.execFile(file, args, error => error ? reject(error) : resolve());
	});
}

function execFileOutput(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.execFile(file, args, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
}

export function toGigabytes(bytes: number): string {
	return (bytes / 1e9).toFixed(1);
}
