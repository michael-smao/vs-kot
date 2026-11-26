/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the socket of the bridge. Every window has one, ~/.vs-kot/bridge/<pid>.sock, where pid is the process of
// this window's extension host. The folder is for this user only, so is the socket.
//
// A program sends one JSON object per line and gets one back per line, with the same `id`:
//
//     {"id": 1, "method": "state"}
//     {"id": 1, "result": {"protocol": 1, "folders": ["/Users/…/vs-kot"], "review": {"files": 4, …}, …}}
//
//     {"id": 2, "method": "run", "params": {"action": "approve-change"}}
//     {"id": 2, "result": null}
//
//     {"id": 3, "method": "run", "params": {"action": "fly"}}
//     {"id": 3, "error": {"code": "failed", "message": "The bridge does not know the action \"fly\"."}}
//
// The methods are `state`, `run` (with an action), `recent` (the folders opened last) and `open` (with a path).
// What they do is in the workbench: src/vs/workbench/contrib/vsKotBridge. A socket left behind by a window that
// crashed refuses to connect; a program may delete it.

import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const BRIDGE_FOLDER = path.join(os.homedir(), '.vs-kot', 'bridge');

/** Raised when what a request or an answer looks like changes so that a program written for the one before breaks. */
const PROTOCOL = 1;
/** A request is a few dozen bytes. A line this long is no request, and the connection is closed. */
const MAX_LINE = 64 * 1024;

const enum WorkbenchCommand {
	State = '_vsKotBridge.state',
	Run = '_vsKotBridge.run',
	Recent = '_vsKotBridge.recent',
	Open = '_vsKotBridge.open',
}

class BridgeError extends Error {
	constructor(readonly code: 'bad-request' | 'unknown-method', message: string) {
		super(message);
	}
}

export class BridgeServer implements vscode.Disposable {

	private readonly _socketPath = path.join(BRIDGE_FOLDER, `${process.pid}.sock`);
	private _server: net.Server | undefined;
	private readonly _connections = new Set<net.Socket>();

	/** When this window was last in front, in milliseconds since 1970. A program sends to the one used last. */
	private _lastFocused = vscode.window.state.focused ? Date.now() : 0;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(private readonly _log: vscode.LogOutputChannel) {
		this._disposables.push(vscode.window.onDidChangeWindowState(state => {
			if (state.focused) {
				this._lastFocused = Date.now();
			}
		}));
	}

	get isRunning(): boolean {
		return !!this._server;
	}

	async start(): Promise<void> {
		if (this._server) {
			return;
		}
		const server = net.createServer(socket => this._accept(socket));
		this._server = server;
		try {
			await prepareFolder();
			await fs.rm(this._socketPath, { force: true });
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(this._socketPath, resolve);
			});
			await fs.chmod(this._socketPath, 0o600);
		} catch (error) {
			this._log.error(`The bridge cannot listen in ${BRIDGE_FOLDER}: ${error}`);
			if (this._server === server) {
				this.stop();
			}
			return;
		}
		if (this._server !== server) {
			return; // stopped while it started
		}
		server.on('error', error => {
			this._log.error(`The bridge stopped: ${error.message}`);
			this.stop();
		});
		this._log.info(`The bridge listens on ${this._socketPath}`);
	}

	stop(): void {
		for (const socket of this._connections) {
			socket.destroy();
		}
		this._connections.clear();
		if (this._server) {
			this._server.close();
			this._server = undefined;
			fs.rm(this._socketPath, { force: true }).catch(() => { /* gone already */ });
		}
	}

	dispose(): void {
		this.stop();
		this._disposables.forEach(disposable => disposable.dispose());
	}

	private _accept(socket: net.Socket): void {
		this._connections.add(socket);
		socket.setEncoding('utf8');
		let buffered = '';

		socket.on('data', (chunk: string) => {
			buffered += chunk;
			let newline: number;
			while ((newline = buffered.indexOf('\n')) !== -1) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line) {
					this._answer(socket, line);
				}
			}
			if (buffered.length > MAX_LINE) {
				socket.destroy();
			}
		});
		socket.on('error', () => socket.destroy());
		socket.on('close', () => this._connections.delete(socket));
	}

	private async _answer(socket: net.Socket, line: string): Promise<void> {
		let id: unknown = null;
		let answer: object;
		try {
			const request = parse(line);
			id = request.id ?? null;
			answer = { id, result: (await this._handle(request.method, request.params)) ?? null };
		} catch (error) {
			const code = error instanceof BridgeError ? error.code : 'failed';
			answer = { id, error: { code, message: error instanceof Error ? error.message : String(error) } };
		}
		if (!socket.destroyed) {
			socket.write(JSON.stringify(answer) + '\n');
		}
	}

	private async _handle(method: unknown, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case 'state': {
				const state = await vscode.commands.executeCommand<object>(WorkbenchCommand.State);
				const focused = vscode.window.state.focused;
				return {
					protocol: PROTOCOL,
					pid: process.pid,
					name: vscode.workspace.name ?? null,
					folders: (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
					lastFocused: focused ? Date.now() : this._lastFocused,
					...state,
				};
			}
			case 'run':
				if (typeof params.action !== 'string') {
					throw new BridgeError('bad-request', '`run` needs an action.');
				}
				return vscode.commands.executeCommand(WorkbenchCommand.Run, params.action);
			case 'recent':
				return vscode.commands.executeCommand(WorkbenchCommand.Recent);
			case 'open':
				if (typeof params.path !== 'string') {
					throw new BridgeError('bad-request', '`open` needs a path.');
				}
				return vscode.commands.executeCommand(WorkbenchCommand.Open, params.path);
			default:
				throw new BridgeError('unknown-method', `The bridge has no method ${JSON.stringify(method)}.`);
		}
	}
}

function parse(line: string): { id?: unknown; method: unknown; params: Record<string, unknown> } {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch {
		throw new BridgeError('bad-request', 'A request is one JSON object per line.');
	}
	if (!request || typeof request !== 'object' || Array.isArray(request)) {
		throw new BridgeError('bad-request', 'A request is one JSON object per line.');
	}
	const { id, method, params } = request as { id?: unknown; method?: unknown; params?: unknown };
	return { id, method, params: params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {} };
}

/** The folder of the sockets: made for this user only, and never one that a link leads to. */
async function prepareFolder(): Promise<void> {
	await fs.mkdir(BRIDGE_FOLDER, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(BRIDGE_FOLDER);
	if (!stat.isDirectory()) {
		throw new Error('it is not a folder');
	}
	if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
		throw new Error('it belongs to another user');
	}
	if ((stat.mode & 0o777) !== 0o700) {
		await fs.chmod(BRIDGE_FOLDER, 0o700);
	}
}
