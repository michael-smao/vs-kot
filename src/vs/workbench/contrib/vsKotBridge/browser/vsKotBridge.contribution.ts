/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the commands behind the bridge. See ../common/vsKotBridge.ts.

import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Schemas } from '../../../../base/common/network.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isRecentFolder, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ChangeReviewCommandId, IChangeReviewService } from '../../changeReview/common/changeReview.js';
import { ClaudeConnectionState, IClaudeRecordService } from '../../changeReview/common/claudeRecord.js';
import { ISCMService } from '../../scm/common/scm.js';
import { getTabCompletionHealth, ITabCompletionStatusService, TabCompletionHealth } from '../../vsKotTabCompletion/common/tabCompletion.js';
import { isVsKotBridgeAction, IVsKotBridgeFormatResult, IVsKotBridgeRecentFolder, IVsKotBridgeState, VsKotBridgeAction, VsKotBridgeCommandId } from '../common/vsKotBridge.js';
import { formatProject } from './formatProject.js';

/** The actions that are one command of the editor, run as they are. */
const COMMANDS: Partial<Record<VsKotBridgeAction, string>> = {
	'approve-change': ChangeReviewCommandId.ApproveChange,
	'approve-file': ChangeReviewCommandId.ApproveFile,
	'request-change': ChangeReviewCommandId.RequestChange,
	'undo-request': ChangeReviewCommandId.UndoRequest,
	'next-change': ChangeReviewCommandId.NextChange,
	'previous-change': ChangeReviewCommandId.PreviousChange,
	'next-file': ChangeReviewCommandId.NextFile,
	'previous-file': ChangeReviewCommandId.PreviousFile,
	'copy-requests': ChangeReviewCommandId.CopyRequests,
	'toggle-review': ChangeReviewCommandId.Toggle,
	'accept-suggestion': 'editor.action.inlineSuggest.commit',
	'accept-word': 'editor.action.inlineSuggest.acceptNextWord',
	'accept-line': 'editor.action.inlineSuggest.acceptNextLine',
	'dismiss-suggestion': 'editor.action.inlineSuggest.hide',
	'suggest': 'editor.action.inlineSuggest.trigger',
	'toggle-tab-completion': 'tabCompletion.toggle',
};

/** Actions that need the window in front: the reviewer types a note into it. */
const NEEDS_FOCUS = new Set<VsKotBridgeAction>(['request-change']);

/** How many recent folders are offered. */
const RECENT_FOLDERS = 20;

/**
 * The git extension reads the status again after a file changed only once the window is in front. Asked from behind,
 * the window has it read this often at most, so what Claude Code writes meanwhile reaches the display.
 */
const REFRESH_BEHIND_MS = 3000;
let lastRefresh = 0;

/** The run of `format-project` in this window, while there is one, and the last one after it. */
let formatting: (IVsKotBridgeFormatResult & { running: boolean }) | undefined;

CommandsRegistry.registerCommand(VsKotBridgeCommandId.State, async (accessor: ServicesAccessor): Promise<IVsKotBridgeState> => {
	const reviewService = accessor.get(IChangeReviewService);
	const claudeRecordService = accessor.get(IClaudeRecordService);
	const tabCompletionService = accessor.get(ITabCompletionStatusService);
	const editorService = accessor.get(IEditorService);
	const contextService = accessor.get(IWorkspaceContextService);
	const hostService = accessor.get(IHostService);
	const scmService = accessor.get(ISCMService);
	const commandService = accessor.get(ICommandService);

	if (!hostService.hasFocus && Date.now() - lastRefresh > REFRESH_BEHIND_MS) {
		lastRefresh = Date.now();
		for (const repository of scmService.repositories) {
			// By its root, so the git extension never asks which repository is meant
			if (repository.provider.providerId === 'git' && repository.provider.rootUri) {
				commandService.executeCommand('git.refresh', repository.provider.rootUri).catch(() => { /* answered by the next request */ });
			}
		}
	}

	const files = reviewService.files;
	const editorFile = EditorResourceAccessor.getOriginalUri(editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
	const folder = editorFile ? contextService.getWorkspaceFolder(editorFile) : null;
	const status = tabCompletionService.status;
	const usage = tabCompletionService.usage;
	const lastHeard = await claudeRecordService.getLastHeard();

	return {
		focused: hostService.hasFocus,
		review: {
			enabled: reviewService.enabled,
			files: files.length,
			pending: reviewService.pendingFiles.length,
			claude: files.filter(file => claudeRecordService.getEntries(file.uri).length > 0).length,
			requests: reviewService.requests.length,
			file: editorFile && editorFile.scheme === Schemas.file ? (folder ? relativePath(folder.uri, editorFile) : undefined) ?? basename(editorFile) : undefined,
			fileUnderReview: !!editorFile && !!reviewService.getFile(editorFile),
		},
		claude: {
			connected: claudeRecordService.connectionState === ClaudeConnectionState.Connected,
			lastHeard: lastHeard?.time,
		},
		tabCompletion: status && {
			enabled: status.enabled,
			state: status.state,
			healthy: getTabCompletionHealth(status) === TabCompletionHealth.Good,
			model: status.model,
			today: usage?.today,
			week: usage?.week,
		},
		formatting,
	};
});

CommandsRegistry.registerCommand(VsKotBridgeCommandId.Run, async (accessor: ServicesAccessor, action: unknown): Promise<unknown> => {
	if (!isVsKotBridgeAction(action)) {
		throw new Error(`The bridge does not know the action ${JSON.stringify(action)}.`);
	}
	const hostService = accessor.get(IHostService);
	const commandService = accessor.get(ICommandService);

	if (action === 'focus') {
		await hostService.focus(mainWindow, { mode: FocusMode.Force });
		return undefined;
	}

	if (action === 'format-project') {
		return runFormatProject(accessor);
	}

	if (NEEDS_FOCUS.has(action)) {
		await hostService.focus(mainWindow, { mode: FocusMode.Force });
	}
	return commandService.executeCommand(COMMANDS[action]!);
});

function runFormatProject(accessor: ServicesAccessor): Promise<IVsKotBridgeFormatResult> {
	if (formatting?.running) {
		throw new Error('The project is being formatted already.');
	}
	const instantiationService = accessor.get(IInstantiationService);
	const progressService = accessor.get(IProgressService);
	const notificationService = accessor.get(INotificationService);

	const cancellation = new CancellationTokenSource();
	formatting = { checked: 0, formatted: 0, skipped: 0, running: true };

	return progressService.withProgress({
		location: ProgressLocation.Notification,
		title: localize('formatProject', "Formatting the project"),
		cancellable: true,
	}, async progress => {
		try {
			const result = await instantiationService.invokeFunction(formatProject, (result, total) => {
				formatting = { ...result, running: true };
				progress.report({ message: localize('formatProjectProgress', "{0} of {1} files", result.checked, total), increment: total ? 100 / total : undefined });
			}, cancellation.token);
			formatting = { ...result, running: false };
			notificationService.status(result.formatted === 1
				? localize('formatProjectOne', "1 file formatted and staged.")
				: localize('formatProjectDone', "{0} files formatted and staged.", result.formatted), { hideAfter: 5000 });
			return result;
		} catch (error) {
			formatting = formatting && { ...formatting, running: false };
			throw error;
		} finally {
			cancellation.dispose();
		}
	}, () => cancellation.cancel());
}

CommandsRegistry.registerCommand(VsKotBridgeCommandId.Recent, async (accessor: ServicesAccessor): Promise<IVsKotBridgeRecentFolder[]> => {
	const recent = await accessor.get(IWorkspacesService).getRecentlyOpened();
	return recent.workspaces
		.filter(isRecentFolder)
		.filter(entry => entry.folderUri.scheme === Schemas.file && !entry.remoteAuthority)
		.slice(0, RECENT_FOLDERS)
		.map(entry => ({ path: entry.folderUri.fsPath, name: basename(entry.folderUri) }));
});

CommandsRegistry.registerCommand(VsKotBridgeCommandId.Open, async (accessor: ServicesAccessor, path: unknown): Promise<void> => {
	if (typeof path !== 'string' || !isAbsolute(path)) {
		throw new Error('The bridge opens a folder by its absolute path.');
	}
	// A window of its own, so the folder of this window stays open. A folder that is open already only comes to the front.
	await accessor.get(IHostService).openWindow([{ folderUri: URI.file(path) }], { forceNewWindow: true });
});
