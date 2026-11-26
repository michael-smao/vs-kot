/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the bridge. A program on this computer, such as Anydeck with the vs-kot extension, asks an open window
// how the review stands and tells it what to do, also while another app is in front.
//
// The socket itself belongs to the built-in extension `extensions/vs-kot-bridge`, which has Node: one socket per
// window, under ~/.vs-kot/bridge, readable by this user only. It hands every request to the commands below. These
// commands do only what {@link VS_KOT_BRIDGE_ACTIONS} lists, so the bridge is no way to run any command at all.

/** Run by the extension. Not for the command palette: their ids start with an underscore. */
export const enum VsKotBridgeCommandId {
	/** Answers with an {@link IVsKotBridgeState}. */
	State = '_vsKotBridge.state',
	/** Does one of {@link VS_KOT_BRIDGE_ACTIONS}. */
	Run = '_vsKotBridge.run',
	/** Answers with the folders opened last, as {@link IVsKotBridgeRecentFolder}s. */
	Recent = '_vsKotBridge.recent',
	/** Opens a folder in a window of its own, or brings the window to the front that has it open already. */
	Open = '_vsKotBridge.open',
}

/** What the bridge can be told to do, by the names the other program uses. */
export const VS_KOT_BRIDGE_ACTIONS = [
	// the change review
	'approve-change',
	'approve-file',
	'request-change',
	'undo-request',
	'next-change',
	'previous-change',
	'next-file',
	'previous-file',
	'copy-requests',
	'toggle-review',
	// tab completion
	'accept-suggestion',
	'accept-word',
	'accept-line',
	'dismiss-suggestion',
	'suggest',
	'toggle-tab-completion',
	// the project
	'format-project',
	// the window
	'focus',
] as const;

export type VsKotBridgeAction = typeof VS_KOT_BRIDGE_ACTIONS[number];

export function isVsKotBridgeAction(value: unknown): value is VsKotBridgeAction {
	return typeof value === 'string' && (VS_KOT_BRIDGE_ACTIONS as readonly string[]).includes(value);
}

/** Counts of what tab completion wrote, as the Tab Completion view shows them. */
export interface IVsKotBridgeCompletionCounts {
	readonly shown: number;
	readonly accepted: number;
	readonly lines: number;
	readonly characters: number;
}

export interface IVsKotBridgeState {
	/** Whether this window is the one in front. */
	readonly focused: boolean;
	readonly review: {
		readonly enabled: boolean;
		/** Files under review: with unstaged changes, or with changes Claude Code staged that nobody approved. */
		readonly files: number;
		/** Of those, the files that still have changes that are neither approved nor flagged. */
		readonly pending: number;
		/** Of the files under review, those with changes that Claude Code made. */
		readonly claude: number;
		/** Changes the reviewer asked to be done again. */
		readonly requests: number;
		/** The file in the editor, relative to its folder. */
		readonly file?: string;
		/** Whether the file in the editor is under review. */
		readonly fileUnderReview: boolean;
	};
	readonly claude: {
		readonly connected: boolean;
		/** When Claude Code last ran the hook, in milliseconds since 1970. */
		readonly lastHeard?: number;
	};
	/** Missing until the extension of tab completion reported for the first time. */
	readonly tabCompletion?: {
		readonly enabled: boolean;
		/** As the Tab Completion view has it: `ready`, `failed`, `needsSetup`, ... */
		readonly state: string;
		readonly healthy: boolean;
		readonly model: string;
		readonly today?: IVsKotBridgeCompletionCounts;
		readonly week?: IVsKotBridgeCompletionCounts;
	};
	/** How a run of `format-project` stands, while one runs and after. */
	readonly formatting?: IVsKotBridgeFormatResult & { readonly running: boolean };
}

export interface IVsKotBridgeFormatResult {
	/** Files that were looked at. */
	readonly checked: number;
	/** Files the formatter changed. They were saved and staged. */
	readonly formatted: number;
	/** Files that were left alone: under review, or with unsaved changes. */
	readonly skipped: number;
}

export interface IVsKotBridgeRecentFolder {
	readonly path: string;
	readonly name: string;
}
