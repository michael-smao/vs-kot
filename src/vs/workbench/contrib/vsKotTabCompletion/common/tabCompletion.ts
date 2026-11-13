/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: what the workbench knows about tab completion.
//
// Tab completion itself is the built-in extension `extensions/vs-kot-tab-completion`: it runs the model server
// and makes the suggestions. The workbench only shows how it is doing, as a view in the side bar and as the colour
// of that view's icon in the activity bar. The extension tells the workbench by running the command
// `ReportTabCompletionStatusCommandId` with an `ITabCompletionStatus` whenever something changes. How much it was
// used comes the same way, see ./tabCompletionUsage.ts.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isObject, isString } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITabCompletionUsage } from './tabCompletionUsage.js';

export const TAB_COMPLETION_VIEW_CONTAINER_ID = 'workbench.view.tabCompletion';
export const TAB_COMPLETION_VIEW_ID = 'workbench.view.tabCompletion.status';

/** Run by the extension to hand over its status. */
export const ReportTabCompletionStatusCommandId = '_tabCompletion.reportStatus';

/** Offered by the extension. All but the last one are also in the command palette. */
export const enum TabCompletionExtensionCommandId {
	SetUp = 'tabCompletion.setUp',
	Toggle = 'tabCompletion.toggle',
	StopServer = 'tabCompletion.stopServer',
	ShowLog = 'tabCompletion.showLog',
	/** Makes the extension look at its model server again and report. */
	RequestStatus = '_tabCompletion.requestStatus',
	/** Makes the extension report how much it was used. */
	RequestUsage = '_tabCompletion.requestUsage',
	/** Makes the extension forget how much it was used and count anew. */
	ResetUsage = '_tabCompletion.resetUsage'
}

/** The settings of the extension that the view reads or changes. */
export const enum TabCompletionSetting {
	Model = 'tabCompletion.model'
}

const tabCompletionStates = ['unsupported', 'needsSetup', 'settingUp', 'starting', 'ready', 'stopped', 'failed', 'unreachable'] as const;

/**
 * - `unsupported`: this computer cannot run the model itself
 * - `needsSetup`: the model server or the model still has to be downloaded
 * - `settingUp`: that download is running
 * - `starting`: the model server is coming up or loads the model
 * - `ready`: suggestions work
 * - `stopped`: the model server was stopped by the user
 * - `failed`: setting up or starting went wrong
 * - `unreachable`: a model server from the settings does not answer
 */
export type TabCompletionState = typeof tabCompletionStates[number];

export interface ITabCompletionModel {
	readonly name: string;
	/** Size on disk in bytes, when the model server tells. For a model on offer, the size of its download. */
	readonly size?: number;
	/** A word or two on what a model on offer is good for. Already in the user's language. */
	readonly description?: string;
}

export interface ITabCompletionStatus {
	/** Whether suggestions are switched on in the settings. */
	readonly enabled: boolean;
	/** `managed`: the editor runs the model server on this computer. `external`: the server is one from the settings. */
	readonly server: 'managed' | 'external';
	readonly state: TabCompletionState;
	/** The current step while setting up, or what went wrong. Already in the user's language. */
	readonly message?: string;
	/** Progress of the current step while setting up, 0 to 100. */
	readonly percent?: number;
	readonly endpoint: string;
	/** The model that is used, whether it was chosen or picked by the editor. */
	readonly model: string;
	/** Whether the editor picked the model, because the setting is empty. */
	readonly isModelAutomatic: boolean;
	/** The models the model server has, as far as it could be asked. */
	readonly installedModels: readonly ITabCompletionModel[];
	/**
	 * The models the editor offers to choose from, whether they are on this computer or not. The first one is
	 * what the editor picks when the setting is empty. None with a model server from the settings.
	 */
	readonly offeredModels: readonly ITabCompletionModel[];
}

/**
 * Checks what an extension sent. Anything that is not a complete status is dropped.
 */
export function parseTabCompletionStatus(value: unknown): ITabCompletionStatus | undefined {
	if (!isObject(value)) {
		return undefined;
	}

	const candidate = value as { [key in keyof ITabCompletionStatus]?: unknown };
	const state = tabCompletionStates.find(known => known === candidate.state);
	if (typeof candidate.enabled !== 'boolean' || (candidate.server !== 'managed' && candidate.server !== 'external') || !state || !isString(candidate.endpoint) || !isString(candidate.model)) {
		return undefined;
	}

	const parseModels = (models: unknown) => {
		const parsed: ITabCompletionModel[] = [];
		if (Array.isArray(models)) {
			for (const model of models) {
				if (isObject(model) && isString((model as { name?: unknown }).name)) {
					const { name, size, description } = model as { name: string; size?: unknown; description?: unknown };
					parsed.push({ name, size: typeof size === 'number' ? size : undefined, description: isString(description) ? description : undefined });
				}
			}
		}
		return parsed;
	};

	return {
		enabled: candidate.enabled,
		server: candidate.server,
		state,
		message: isString(candidate.message) ? candidate.message : undefined,
		percent: typeof candidate.percent === 'number' ? Math.max(0, Math.min(100, candidate.percent)) : undefined,
		endpoint: candidate.endpoint,
		model: candidate.model,
		isModelAutomatic: candidate.isModelAutomatic === true,
		installedModels: parseModels(candidate.installedModels),
		offeredModels: parseModels(candidate.offeredModels)
	};
}

export const enum TabCompletionHealth {
	/** Switched on and working. */
	Good = 'good',
	/** Switched on, but no suggestions can come. */
	Problem = 'problem',
	/** Switched off, still coming up, or not heard from yet. */
	Neutral = 'neutral'
}

/**
 * The one-word answer behind the colour of the activity bar icon.
 */
export function getTabCompletionHealth(status: ITabCompletionStatus | undefined): TabCompletionHealth {
	if (!status || !status.enabled) {
		return TabCompletionHealth.Neutral;
	}

	switch (status.state) {
		case 'ready':
			return TabCompletionHealth.Good;
		case 'settingUp':
		case 'starting':
			return TabCompletionHealth.Neutral;
		case 'unsupported':
		case 'needsSetup':
		case 'stopped':
		case 'failed':
		case 'unreachable':
			return TabCompletionHealth.Problem;
	}
}

/** What the view offers to do about a status. */
export const enum TabCompletionAction {
	SetUp = 'setUp',
	Start = 'start',
	TryAgain = 'tryAgain',
	TurnOn = 'turnOn',
	TurnOff = 'turnOff',
	OpenSettings = 'openSettings'
}

export interface ITabCompletionDescription {
	readonly health: TabCompletionHealth;
	/** Whether something is in progress that ends by itself. */
	readonly busy: boolean;
	readonly title: string;
	readonly detail: string;
	/** What can be done now. The first one is what most likely helps. */
	readonly actions: readonly TabCompletionAction[];
	/** How the model server is doing, in a word or two. Empty while nothing is known. */
	readonly serverState: string;
}

/**
 * Says in words what a status means and what can be done about it.
 */
export function describeTabCompletionStatus(status: ITabCompletionStatus | undefined): ITabCompletionDescription {
	const health = getTabCompletionHealth(status);

	if (!status) {
		return { health, busy: true, title: localize('status.waiting', "Starting"), detail: localize('status.waiting.detail', "Tab Completion has not started yet."), actions: [], serverState: '' };
	}

	const serverState = describeServerState(status);
	if (!status.enabled) {
		return { health, busy: false, title: localize('status.off', "Off"), detail: localize('status.off.detail', "Suggestions are switched off."), actions: [TabCompletionAction.TurnOn], serverState };
	}

	switch (status.state) {
		case 'unsupported':
			return {
				health, busy: false, serverState,
				title: localize('status.unsupported', "Not Available"),
				detail: localize('status.unsupported.detail', "Tab Completion can run its model itself only on a Mac with Apple silicon. On this computer it needs the address of a model server in the settings."),
				actions: [TabCompletionAction.OpenSettings, TabCompletionAction.TurnOff]
			};
		case 'needsSetup':
			return {
				health, busy: false, serverState,
				title: localize('status.needsSetup', "Needs Setup"),
				detail: localize('status.needsSetup.detail', "The model {0}, or the model server that runs it, is not on this computer yet.", status.model),
				actions: [TabCompletionAction.SetUp, TabCompletionAction.TurnOff]
			};
		case 'settingUp':
			return {
				health, busy: true, serverState,
				title: localize('status.settingUp', "Setting Up"),
				detail: status.message
					? (status.percent === undefined ? status.message : localize('status.settingUp.progress', "{0}: {1}%", status.message, Math.round(status.percent)))
					: localize('status.settingUp.detail', "Tab Completion is downloading what it needs."),
				actions: []
			};
		case 'starting':
			return {
				health, busy: true, serverState,
				title: localize('status.starting', "Starting"),
				detail: localize('status.starting.detail', "The model {0} is being loaded.", status.model),
				actions: [TabCompletionAction.TurnOff]
			};
		case 'ready':
			return {
				health, busy: false, serverState,
				title: localize('status.ready', "Ready"),
				detail: status.server === 'managed'
					? localize('status.ready.managed', "Suggestions appear as you type, and Tab accepts them. The model {0} runs on this computer.", status.model)
					: localize('status.ready.external', "Suggestions appear as you type, and Tab accepts them. The model {0} runs on {1}.", status.model, status.endpoint),
				actions: [TabCompletionAction.TurnOff]
			};
		case 'stopped':
			return {
				health, busy: false, serverState,
				title: localize('status.stopped', "Stopped"),
				detail: localize('status.stopped.detail', "The model server is stopped, so no suggestions appear."),
				actions: [TabCompletionAction.Start, TabCompletionAction.TurnOff]
			};
		case 'failed':
			return {
				health, busy: false, serverState,
				title: localize('status.failed', "Not Working"),
				detail: status.message || localize('status.failed.detail', "Something went wrong. The log has the details."),
				actions: [TabCompletionAction.TryAgain, TabCompletionAction.TurnOff]
			};
		case 'unreachable':
			return {
				health, busy: false, serverState,
				title: localize('status.unreachable', "No Answer"),
				detail: localize('status.unreachable.detail', "The model server at {0} does not answer. Tab Completion tries again while you type.", status.endpoint),
				actions: [TabCompletionAction.OpenSettings, TabCompletionAction.TurnOff]
			};
	}
}

function describeServerState(status: ITabCompletionStatus): string {
	switch (status.state) {
		case 'unsupported': return localize('server.unsupported', "Not available on this computer");
		case 'needsSetup': return localize('server.needsSetup', "Not set up");
		case 'settingUp': return localize('server.settingUp', "Being set up");
		case 'starting': return localize('server.starting', "Starting");
		case 'ready': return status.server === 'managed' ? localize('server.running', "Running") : localize('server.answers', "Answers");
		case 'stopped': return localize('server.stopped', "Stopped");
		case 'failed': return localize('server.failed', "Not working");
		case 'unreachable': return localize('server.unreachable', "No answer");
	}
}

export const ITabCompletionStatusService = createDecorator<ITabCompletionStatusService>('vsKotTabCompletionStatusService');

export interface ITabCompletionStatusService {
	readonly _serviceBrand: undefined;

	/** The last status the extension reported. `undefined` until it reported for the first time. */
	readonly status: ITabCompletionStatus | undefined;
	readonly onDidChangeStatus: Event<void>;

	report(status: ITabCompletionStatus): void;

	/** How much tab completion was used, as the extension reported last. `undefined` until it reported for the first time. */
	readonly usage: ITabCompletionUsage | undefined;
	readonly onDidChangeUsage: Event<void>;

	reportUsage(usage: ITabCompletionUsage): void;
}

export class TabCompletionStatusService extends Disposable implements ITabCompletionStatusService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<void>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private _status: ITabCompletionStatus | undefined;

	get status(): ITabCompletionStatus | undefined {
		return this._status;
	}

	report(status: ITabCompletionStatus): void {
		this._status = status;
		this._onDidChangeStatus.fire();
	}

	private readonly _onDidChangeUsage = this._register(new Emitter<void>());
	readonly onDidChangeUsage = this._onDidChangeUsage.event;

	private _usage: ITabCompletionUsage | undefined;

	get usage(): ITabCompletionUsage | undefined {
		return this._usage;
	}

	reportUsage(usage: ITabCompletionUsage): void {
		this._usage = usage;
		this._onDidChangeUsage.fire();
	}
}
