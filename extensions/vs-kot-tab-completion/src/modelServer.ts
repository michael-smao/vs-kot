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
const PORT = 11535;

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
/** Room that has to be left on the disk after everything is downloaded. */
const DISK_HEADROOM_BYTES = 3 * 1024 ** 3;

export type ServerState =
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'needsSetup' }
	| { readonly kind: 'settingUp'; readonly step: string; readonly percent: number | undefined }
	| { readonly kind: 'starting' }
	| { readonly kind: 'ready' }
	| { readonly kind: 'stopped' }
	| { readonly kind: 'failed'; readonly message: string };

export class ManagedModelServer implements vscode.Disposable {

	readonly endpoint = `http://127.0.0.1:${PORT}`;

	private readonly _onDidChangeState = new vscode.EventEmitter<ServerState>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private _state: ServerState;
	private _operation: Promise<void> | undefined;

	private readonly _root: string;

	constructor(private readonly _log: vscode.LogOutputChannel) {
		// A fixed folder in the home directory: the source build, the installed app and every profile share one download
		this._root = process.env['VS_KOT_TAB_COMPLETION_HOME'] || path.join(os.homedir(), '.vs-kot', 'tab-completion');
		this._state = process.platform === 'darwin' && process.arch === 'arm64' ? { kind: 'needsSetup' } : { kind: 'unsupported' };
	}

	dispose(): void {
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
	 * Brings the server up if everything it needs is already on this computer. Downloads nothing.
	 */
	initialize(): Promise<void> {
		return this._run(async () => {
			if (this._state.kind === 'unsupported') {
				return;
			}
			if (!await this._isInstalled()) {
				this._setState({ kind: 'needsSetup' });
				return;
			}

			this._setState({ kind: 'starting' });
			await this._start();
			if (!await this._hasModel()) {
				this._setState({ kind: 'needsSetup' });
				return;
			}
			await this._loadModel();
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
				await this._checkDiskSpace();
				if (!await this._isInstalled()) {
					await this._installRuntime(abort.signal);
				}
				this._setState({ kind: 'settingUp', step: vscode.l10n.t('Starting the model server'), percent: undefined });
				await this._start();
				if (!await this._hasModel()) {
					await this._downloadModel(abort.signal);
				}
				this._setState({ kind: 'settingUp', step: vscode.l10n.t('Loading the model'), percent: undefined });
				await this._loadModel();
				this._setState({ kind: 'ready' });
			} catch (error) {
				if (token.isCancellationRequested) {
					this._log.info('Setup cancelled. What was downloaded so far is kept and reused next time.');
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

	/** Stops the server. It starts again with the next window, or when asked to through {@link setUp}. */
	async stop(): Promise<void> {
		await this._run(async () => {
			const pid = await this._readPid();
			if (pid !== undefined) {
				try {
					process.kill(pid);
					this._log.info(`Stopped the model server (process ${pid}).`);
				} catch {
					// it was not running anymore
				}
				await fs.promises.rm(this._pidFile, { force: true });
			}
			if (this._state.kind === 'ready' || this._state.kind === 'starting') {
				this._setState({ kind: 'stopped' });
			}
		});
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

	private async _checkDiskSpace(): Promise<void> {
		const needed = await this.getPendingDownloadSize();
		if (needed === undefined) {
			return;
		}
		await fs.promises.mkdir(this._root, { recursive: true });
		const stats = await fs.promises.statfs(this._root);
		const free = stats.bavail * stats.bsize;
		if (free < needed + DISK_HEADROOM_BYTES) {
			throw new Error(vscode.l10n.t('Not enough free disk space: {0} GB are needed, {1} GB are free.', toGigabytes(needed + DISK_HEADROOM_BYTES), toGigabytes(free)));
		}
	}

	private async _installRuntime(signal: AbortSignal): Promise<void> {
		const step = vscode.l10n.t('Downloading the model server');
		this._setState({ kind: 'settingUp', step, percent: 0 });
		this._log.info(`Downloading ${RUNTIME.url}`);

		const downloadDir = path.join(this._root, 'runtime');
		await fs.promises.mkdir(downloadDir, { recursive: true });
		// Names of its own per window, so that two windows that set up at the same time don't write into each other's files
		const archive = path.join(downloadDir, `${RUNTIME.version}.${process.pid}.tgz.part`);
		const extractDir = path.join(downloadDir, `${RUNTIME.version}.${process.pid}.part`);

		const response = await fetch(RUNTIME.url, { signal, redirect: 'follow' });
		if (!response.ok || !response.body) {
			throw new Error(vscode.l10n.t('The model server could not be downloaded: {0}', `${response.status} ${response.statusText}`));
		}
		const total = Number(response.headers.get('content-length')) || RUNTIME.downloadSize;
		const hash = crypto.createHash('sha256');
		const file = fs.createWriteStream(archive);
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
				if (!file.write(value)) {
					await new Promise<void>(resolve => file.once('drain', resolve));
				}
				this._setState({ kind: 'settingUp', step, percent: Math.min(100, Math.floor(received / total * 100)) });
			}
		} finally {
			await new Promise<void>(resolve => file.end(resolve));
		}

		// Only what is exactly the pinned release file gets unpacked and run
		const actual = hash.digest('hex');
		if (actual !== RUNTIME.sha256) {
			await fs.promises.rm(archive, { force: true });
			throw new Error(vscode.l10n.t('The downloaded model server is not the expected file. Nothing was installed.'));
		}

		this._setState({ kind: 'settingUp', step: vscode.l10n.t('Unpacking the model server'), percent: undefined });
		await fs.promises.rm(extractDir, { recursive: true, force: true });
		await fs.promises.mkdir(extractDir, { recursive: true });
		await execFile('/usr/bin/tar', ['-xzf', archive, '-C', extractDir]);
		if (await this._isInstalled()) {
			await fs.promises.rm(extractDir, { recursive: true, force: true }); // another window was faster
		} else {
			await fs.promises.rm(this._runtimeDir, { recursive: true, force: true });
			await fs.promises.rename(extractDir, this._runtimeDir);
		}
		await fs.promises.rm(archive, { force: true });
		this._log.info(`Installed the model server ${RUNTIME.version} in ${this._runtimeDir}`);
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

	private get _pidFile(): string {
		return path.join(this._root, 'server.pid');
	}

	private async _readPid(): Promise<number | undefined> {
		try {
			const pid = Number(await fs.promises.readFile(this._pidFile, 'utf8'));
			return Number.isInteger(pid) && pid > 0 ? pid : undefined;
		} catch {
			return undefined;
		}
	}

	private async _isUp(): Promise<boolean> {
		try {
			const response = await fetch(`${this.endpoint}/api/version`, { signal: AbortSignal.timeout(1500) });
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Starts the server unless it runs already. It is started on its own, not as a child of this window:
	 * other windows use it too, and it needs next to nothing while nobody types.
	 */
	private async _start(): Promise<void> {
		if (await this._isUp()) {
			return;
		}

		const modelsDir = path.join(this._root, 'models');
		await fs.promises.mkdir(modelsDir, { recursive: true });
		const logFile = await fs.promises.open(path.join(this._root, 'server.log'), 'a');
		let child: cp.ChildProcess;
		try {
			child = cp.spawn(this._binary, ['serve'], {
				detached: true,
				stdio: ['ignore', logFile.fd, logFile.fd],
				env: {
					HOME: os.homedir(),
					PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
					TMPDIR: os.tmpdir(),
					OLLAMA_HOST: `127.0.0.1:${PORT}`,
					OLLAMA_MODELS: modelsDir,
					OLLAMA_KEEP_ALIVE: '30m',
					OLLAMA_NO_CLOUD: '1'
				}
			});
			child.unref();
		} finally {
			await logFile.close();
		}

		for (let attempt = 0; attempt < 100; attempt++) {
			if (await this._isUp()) {
				// Several windows may have tried at the same moment. The port lets only one of them through:
				// the others' processes have ended by now, and all windows share the one that got it.
				if (child.exitCode === null && child.pid !== undefined) {
					await fs.promises.writeFile(this._pidFile, String(child.pid));
					this._log.info(`Started the model server (process ${child.pid}) on ${this.endpoint}`);
				} else {
					this._log.info(`Using the model server that another window started on ${this.endpoint}`);
				}
				return;
			}
			await new Promise<void>(resolve => setTimeout(resolve, 200));
		}
		throw new Error(vscode.l10n.t('The model server did not start. See {0}.', path.join(this._root, 'server.log')));
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
		const response = await fetch(`${this.endpoint}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.model, keep_alive: '30m', options: { num_ctx: CONTEXT_TOKENS } }), signal: AbortSignal.timeout(120_000) });
		if (!response.ok) {
			throw new Error(vscode.l10n.t('The model {0} could not be loaded: {1}', this.model, (await response.text()).slice(0, 200)));
		}
		await response.arrayBuffer();
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

export function toGigabytes(bytes: number): string {
	return (bytes / 1e9).toFixed(1);
}
