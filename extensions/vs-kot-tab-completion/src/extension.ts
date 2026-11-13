/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: tab completion from a code model the team runs itself.
//
// By default the editor runs the model on this computer: it offers once to download a model server and a model,
// and from then on starts them by itself. With an endpoint set in the settings it uses a server of your own instead.

import * as vscode from 'vscode';
import { ContextCollector } from './context';
import { ManagedModelServer, toGigabytes } from './modelServer';
import { ICompletionTarget } from './provider';
import { StatusReporter } from './statusReport';
import { CountedTabCompletionProvider, UsageStatistics } from './usage';

const SETUP_OFFERED_KEY = 'tabCompletion.setUpOffered';
const DEFAULT_MODEL_OFFERED_KEY = 'tabCompletion.defaultModelOffered';
/** How long after a failed start of the model server the next keystroke may try again. */
const RETRY_AFTER_FAILURE_MS = 20_000;

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel(vscode.l10n.t('Tab Completion'), { log: true });
	const server = new ManagedModelServer(log);

	/** An endpoint in the settings means a server of the user's own, and nothing is managed here. */
	const getExternalEndpoint = () => vscode.workspace.getConfiguration('tabCompletion').get<string>('endpoint', '').trim().replace(/\/+$/, '');

	let lastRetry = 0;
	const getTarget = (): ICompletionTarget | undefined => {
		const configuration = vscode.workspace.getConfiguration('tabCompletion');
		const external = getExternalEndpoint();
		if (external) {
			return { url: external, api: configuration.get<'ollama' | 'openai'>('api', 'ollama'), model: configuration.get<string>('model', '').trim() || server.model };
		}
		if (server.state.kind === 'failed' && Date.now() - lastRetry > RETRY_AFTER_FAILURE_MS) {
			// What made the server fail may be over. Someone who types on gets it back without having to click anything.
			lastRetry = Date.now();
			server.initialize();
		}
		return server.state.kind === 'ready' ? { url: server.endpoint, api: 'ollama', model: server.model, prepare: () => server.prepare(), noteUse: () => server.noteUse(), canReadAhead: true } : undefined;
	};

	const contextCollector = new ContextCollector(log);
	// How often suggestions appear and are taken is counted, on this computer only, for the Tab Completion view
	const usage = new UsageStatistics(context.globalState);
	const provider = new CountedTabCompletionProvider(usage, log, getTarget, contextCollector);

	// --- status bar

	const statusItem = vscode.window.createStatusBarItem('tabCompletion.status', vscode.StatusBarAlignment.Right, 90);
	statusItem.name = vscode.l10n.t('Tab Completion');
	const label = vscode.l10n.t('Tab');

	const updateStatus = () => {
		const configuration = vscode.workspace.getConfiguration('tabCompletion');
		const show = (icon: string, text: string, tooltip: string, command: string) => {
			statusItem.text = `$(${icon}) ${text}`;
			statusItem.tooltip = tooltip;
			statusItem.command = command;
		};

		if (!configuration.get('enabled', true)) {
			show('circle-slash', label, vscode.l10n.t('Tab Completion is off. Select to turn it on.'), 'tabCompletion.toggle');
			return;
		}

		const external = getExternalEndpoint();
		if (external) {
			if (provider.isReachable) {
				show('zap', label, vscode.l10n.t('Tab Completion is on, using {0}. Tab accepts a suggestion. Select to turn it off.', external), 'tabCompletion.toggle');
			} else {
				show('warning', label, vscode.l10n.t('Tab Completion gets no answer from {0}. It tries again while you type. Select to turn it off.', external), 'tabCompletion.toggle');
			}
			return;
		}

		const state = server.state;
		switch (state.kind) {
			case 'unsupported':
				show('circle-slash', label, vscode.l10n.t('Tab Completion can run its model itself only on a Mac with Apple silicon. On this computer it needs the address of a model server in the settings.'), 'tabCompletion.showLog');
				break;
			case 'needsSetup':
				show('cloud-download', vscode.l10n.t('Tab: Set Up'), vscode.l10n.t('Tab Completion suggests code as you type, from a model that runs on this computer. Select to download what it needs.'), 'tabCompletion.setUp');
				break;
			case 'settingUp':
				show('sync~spin', state.percent === undefined ? label : vscode.l10n.t('Tab: {0}%', state.percent), state.step, 'tabCompletion.showLog');
				break;
			case 'starting':
				show('sync~spin', label, vscode.l10n.t('Tab Completion is starting its model.'), 'tabCompletion.showLog');
				break;
			case 'ready':
				show('zap', label, vscode.l10n.t('Tab Completion is on ({0}, running on this computer). Tab accepts a suggestion. Select to turn it off.', server.model), 'tabCompletion.toggle');
				break;
			case 'stopped':
				show('debug-pause', label, vscode.l10n.t('The model of Tab Completion is stopped. Select to start it again.'), 'tabCompletion.setUp');
				break;
			case 'failed':
				show('warning', label, vscode.l10n.t('Tab Completion is not working: {0} Select to try again.', state.message), 'tabCompletion.setUp');
				break;
		}
	};

	// --- setting up

	let isSettingUp = false;
	/** @param getDefault whether the default model is to be downloaded where another model is used in its place */
	const setUp = async (getDefault = false) => {
		if (getExternalEndpoint()) {
			vscode.window.showInformationMessage(vscode.l10n.t('Tab Completion uses the model server from the settings. There is nothing to set up.'));
			return;
		}
		if (server.state.kind === 'unsupported') {
			vscode.window.showInformationMessage(vscode.l10n.t('Tab Completion can run its model itself only on a Mac with Apple silicon. On this computer it needs the address of a model server in the settings.'));
			return;
		}
		if (isSettingUp) {
			return;
		}

		isSettingUp = true;
		try {
			const isReady = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Setting up Tab Completion'), cancellable: true }, async (progress, token) => {
				const listener = server.onDidChangeState(state => {
					if (state.kind === 'settingUp') {
						progress.report({ message: state.percent === undefined ? state.step : vscode.l10n.t('{0}: {1}%', state.step, state.percent) });
					}
				});
				try {
					return await server.setUp(token, getDefault);
				} finally {
					listener.dispose();
				}
			});

			if (!isReady && getDefault && server.state.kind === 'needsSetup') {
				await server.initialize(); // cancelled: on with the model that is there
			} else if (isReady) {
				vscode.window.showInformationMessage(vscode.l10n.t('Tab Completion is ready. Suggestions appear as you type, and Tab accepts them.'));
			} else if (server.state.kind === 'failed') {
				const showLog = vscode.l10n.t('Show Log');
				const choice = await vscode.window.showErrorMessage(vscode.l10n.t('Tab Completion could not be set up: {0}', server.state.message), showLog);
				if (choice === showLog) {
					log.show();
				}
			}
		} finally {
			isSettingUp = false;
		}
	};

	/** Asks once, the first time the editor runs on a computer where nothing is set up yet. */
	const offerSetUp = async () => {
		if (getExternalEndpoint() || server.state.kind !== 'needsSetup' || context.globalState.get(SETUP_OFFERED_KEY) || !vscode.workspace.getConfiguration('tabCompletion').get('enabled', true)) {
			return;
		}
		await context.globalState.update(SETUP_OFFERED_KEY, true);

		const size = await server.getPendingDownloadSize();
		const message = size === undefined
			? vscode.l10n.t('Tab Completion suggests code as you type, from a model that runs on this Mac. Nothing you type leaves it. Setting it up downloads the model.')
			: vscode.l10n.t('Tab Completion suggests code as you type, from a model that runs on this Mac. Nothing you type leaves it. Setting it up downloads about {0} GB.', toGigabytes(size));
		const setUpChoice = vscode.l10n.t('Set Up');
		const choice = await vscode.window.showInformationMessage(message, setUpChoice, vscode.l10n.t('Not Now'));
		if (choice === setUpChoice) {
			await setUp();
		}
	};

	/**
	 * Asks once on a computer that was set up when the larger model was the default. Tab completion works on with
	 * that model there; moving to the default takes a download, and that is for the user to say.
	 */
	const offerDefaultModel = async () => {
		if (getExternalEndpoint() || !server.isDefaultPending || server.state.kind !== 'ready' || context.globalState.get(DEFAULT_MODEL_OFFERED_KEY)) {
			return;
		}
		await context.globalState.update(DEFAULT_MODEL_OFFERED_KEY, true);

		const current = server.model;
		const switchChoice = vscode.l10n.t('Switch');
		const keepChoice = vscode.l10n.t('Keep Current Model');
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('Tab Completion has a new standard model, {0}: smaller, and several times quicker to answer. This Mac still uses {1}. Switching downloads about {2} GB. Both stay on offer in the Tab Completion view.', server.defaultModel.name, current, toGigabytes(server.defaultModel.downloadSize)),
			switchChoice, keepChoice);
		if (choice === switchChoice) {
			await setUp(true);
		} else if (choice === keepChoice) {
			// Said in the settings, it stays the choice of the user whatever the default becomes
			await vscode.workspace.getConfiguration('tabCompletion').update('model', current, vscode.ConfigurationTarget.Global);
		}
	};

	context.subscriptions.push(
		log,
		server,
		contextCollector,
		provider,
		usage,
		statusItem,
		// Feeds the Tab Completion view in the side bar and the colour of its icon
		new StatusReporter(server, provider, getExternalEndpoint),
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
		// Where the cursor rests, the model reads the code before anything is typed there
		vscode.window.onDidChangeTextEditorSelection(e => provider.noteCursor(e.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(editor => provider.noteCursor(editor)),
		server.onDidChangeState(state => {
			if (state.kind === 'ready') {
				// Whatever went wrong with the server before is over: no waiting period, and failures count anew
				provider.reset();
			}
			updateStatus();
		}),
		provider.onDidChangeReachable(isReachable => {
			updateStatus();
			// The editor's own server may have been stopped: bring it back
			if (!isReachable && !getExternalEndpoint()) {
				server.initialize();
			}
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('tabCompletion')) {
				provider.reset();
				updateStatus();
				if (!getExternalEndpoint() && (e.affectsConfiguration('tabCompletion.model') || e.affectsConfiguration('tabCompletion.endpoint'))) {
					server.initialize();
				}
			}
		}),
		vscode.commands.registerCommand('tabCompletion.setUp', () => setUp()),
		vscode.commands.registerCommand('tabCompletion.toggle', async () => {
			const configuration = vscode.workspace.getConfiguration('tabCompletion');
			await configuration.update('enabled', !configuration.get('enabled', true), vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('tabCompletion.stopServer', () => server.stop()),
		vscode.commands.registerCommand('tabCompletion.showLog', () => log.show())
	);

	updateStatus();
	statusItem.show();

	if (!getExternalEndpoint()) {
		server.initialize().then(async () => {
			await offerSetUp();
			await offerDefaultModel();
		});
	}
}
