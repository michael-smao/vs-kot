/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-claude: tells the workbench how tab completion is doing. The workbench shows it as the Tab Completion view in
// the side bar and as the colour of that view's icon in the activity bar; its side of this is in
// src/vs/workbench/contrib/vsClaudeTabCompletion.

import * as vscode from 'vscode';
import { ManagedModelServer } from './modelServer';
import { TabCompletionProvider } from './provider';

/** Offered by the workbench: takes an {@link IStatusReport}. */
const REPORT_COMMAND = '_tabCompletion.reportStatus';
/** Run by the workbench when the view is opened or refreshed. */
const REQUEST_COMMAND = '_tabCompletion.requestStatus';

/** The progress of a download changes many times a second. The workbench hears of it this often at most. */
const REPORT_INTERVAL_MS = 250;
/** How often a model server from the settings that does not answer is asked again. */
const RETRY_INTERVAL_MS = 60_000;

interface IModel {
	readonly name: string;
	readonly size?: number;
}

/** The same shape as `ITabCompletionStatus` in the workbench. */
interface IStatusReport {
	readonly enabled: boolean;
	readonly server: 'managed' | 'external';
	readonly state: 'unsupported' | 'needsSetup' | 'settingUp' | 'starting' | 'ready' | 'stopped' | 'failed' | 'unreachable';
	readonly message?: string;
	readonly percent?: number;
	readonly endpoint: string;
	readonly model: string;
	readonly isModelAutomatic: boolean;
	readonly installedModels: readonly IModel[];
}

export class StatusReporter implements vscode.Disposable {

	private readonly _disposables: vscode.Disposable[] = [];

	private _reportTimer: ReturnType<typeof setTimeout> | undefined;
	private _lastReport = 0;
	private _retryTimer: ReturnType<typeof setTimeout> | undefined;

	/** What the model server said when it was last asked for its models. */
	private _models: readonly IModel[] = [];
	/** Whether the model server answered at all then. */
	private _answers = true;
	private _lookUps = 0;

	constructor(
		private readonly _server: ManagedModelServer,
		private readonly _provider: TabCompletionProvider,
		private readonly _getExternalEndpoint: () => string,
	) {
		this._disposables.push(
			this._server.onDidChangeState(state => {
				if (state.kind === 'settingUp') {
					this._scheduleReport(); // only the progress moved
				} else {
					this._lookAtServer();
				}
			}),
			this._provider.onDidChangeReachable(() => this._lookAtServer()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('tabCompletion')) {
					this._lookAtServer();
				}
			}),
			vscode.commands.registerCommand(REQUEST_COMMAND, () => this._lookAtServer())
		);

		this._lookAtServer();
	}

	dispose(): void {
		clearTimeout(this._reportTimer);
		clearTimeout(this._retryTimer);
		for (const disposable of this._disposables) {
			disposable.dispose();
		}
	}

	/** Reports what is known right away, then asks the model server for its models and reports again. */
	private async _lookAtServer(): Promise<void> {
		this._scheduleReport();

		const lookUp = ++this._lookUps;
		const external = this._getExternalEndpoint();
		const api = external ? vscode.workspace.getConfiguration('tabCompletion').get<'ollama' | 'openai'>('api', 'ollama') : 'ollama';
		const result = await listModels(external || this._server.endpoint, api);
		if (lookUp !== this._lookUps) {
			return; // asked again in the meantime
		}

		this._models = result?.models ?? [];
		this._answers = result !== undefined;
		this._scheduleReport();

		clearTimeout(this._retryTimer);
		this._retryTimer = external && !this._answers ? setTimeout(() => this._lookAtServer(), RETRY_INTERVAL_MS) : undefined;
	}

	private _scheduleReport(): void {
		if (this._reportTimer) {
			return;
		}
		const wait = Math.max(0, this._lastReport + REPORT_INTERVAL_MS - Date.now());
		this._reportTimer = setTimeout(() => {
			this._reportTimer = undefined;
			this._lastReport = Date.now();
			this._report();
		}, wait);
	}

	private _report(): void {
		const configuration = vscode.workspace.getConfiguration('tabCompletion');
		const external = this._getExternalEndpoint();
		const state = this._server.state;

		const status: IStatusReport = external ? {
			enabled: configuration.get('enabled', true),
			server: 'external',
			state: this._provider.isReachable && this._answers ? 'ready' : 'unreachable',
			endpoint: external,
			model: this._server.model,
			isModelAutomatic: !configuration.get<string>('model', '').trim(),
			installedModels: this._models
		} : {
			enabled: configuration.get('enabled', true),
			server: 'managed',
			state: state.kind,
			message: state.kind === 'settingUp' ? state.step : state.kind === 'failed' ? state.message : undefined,
			percent: state.kind === 'settingUp' ? state.percent : undefined,
			endpoint: this._server.endpoint,
			model: this._server.model,
			isModelAutomatic: !configuration.get<string>('model', '').trim(),
			installedModels: this._models
		};

		// An editor without the view has no such command, and nothing is lost then
		vscode.commands.executeCommand(REPORT_COMMAND, status).then(undefined, () => undefined);
	}
}

/**
 * Asks a model server which models it has.
 * @returns `undefined` when the server did not answer at all. A server that answers but cannot list its
 * models counts as having answered.
 */
async function listModels(endpoint: string, api: 'ollama' | 'openai'): Promise<{ models: IModel[] } | undefined> {
	let response: Response;
	try {
		response = await fetch(api === 'ollama' ? `${endpoint}/api/tags` : `${endpoint}/v1/models`, { signal: AbortSignal.timeout(3000) });
	} catch {
		return undefined;
	}

	try {
		if (!response.ok) {
			return { models: [] };
		}
		if (api === 'ollama') {
			const body = await response.json() as { models?: { name?: unknown; size?: unknown }[] };
			return { models: (body.models ?? []).flatMap(model => typeof model.name === 'string' ? [{ name: model.name, size: typeof model.size === 'number' ? model.size : undefined }] : []) };
		}
		const body = await response.json() as { data?: { id?: unknown }[] };
		return { models: (body.data ?? []).flatMap(model => typeof model.id === 'string' ? [{ name: model.id }] : []) };
	} catch {
		return { models: [] };
	}
}
