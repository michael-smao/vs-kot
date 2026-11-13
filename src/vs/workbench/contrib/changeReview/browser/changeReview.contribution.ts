/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: change review. See ../common/changeReview.ts for what it does.

import { fromNow } from '../../../../base/common/date.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorAction2, EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsMacContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { CHANGE_REVIEW_AUTO_REVEAL_SETTING, CHANGE_REVIEW_ENABLED_SETTING, ChangeReviewCommandId, ctxChangeReviewCursorInChange, ctxChangeReviewHasChanges, ctxChangeReviewHasPendingChanges, IChangeReviewService } from '../common/changeReview.js';
import { CLAUDE_RECORD_FOLDER_SETTING, CLAUDE_SETTINGS_FILE_SETTING, ClaudeConnectionState, ClaudeSettingsError, IClaudeLastHeard, IClaudeRecordService } from '../common/claudeRecord.js';
import { ChangeReviewController } from './changeReviewController.js';
import { ChangeReviewFilesService, IChangeReviewFilesService } from './changeReviewedFile.js';
import { ChangeReviewService } from './changeReviewService.js';
import { ClaudeRecordService } from './claudeRecordService.js';

registerSingleton(IChangeReviewService, ChangeReviewService, InstantiationType.Delayed);
registerSingleton(IChangeReviewFilesService, ChangeReviewFilesService, InstantiationType.Delayed);
registerSingleton(IClaudeRecordService, ClaudeRecordService, InstantiationType.Delayed);

registerEditorContribution(ChangeReviewController.ID, ChangeReviewController, EditorContributionInstantiation.AfterFirstRender);

// --- settings

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'changeReview',
	order: 6,
	title: localize('changeReviewConfigurationTitle', "Change Review"),
	type: 'object',
	properties: {
		[CHANGE_REVIEW_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize('changeReview.enabled', "Show unstaged changes inline in the editor, with buttons to approve them or to request a change. Approving a change stages it in git.")
		},
		[CHANGE_REVIEW_AUTO_REVEAL_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			description: localize('changeReview.autoReveal', "Open a file and jump to its first change when new unstaged changes show up. This does not interrupt the review of a file that still has changes to look at.")
		},
		[CLAUDE_SETTINGS_FILE_SETTING]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('changeReview.claudeCode.settingsFile', "The settings file of Claude Code that its connection to the change review is written to. Leave this empty for the one in the home folder, `~/.claude/settings.json`.")
		},
		[CLAUDE_RECORD_FOLDER_SETTING]: {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			included: false,
			description: localize('changeReview.claudeCode.recordFolder', "The folder in which Claude Code notes for the change review which files it changed. Only tests set this.")
		}
	}
});

// --- status bar

/** Shows how much is left to review. Selecting it goes to the next change. */
class ChangeReviewStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.changeReviewStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IChangeReviewService private readonly _service: IChangeReviewService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
	) {
		super();

		this._register(this._service.onDidChange(() => this._update()));
		this._update();
	}

	private _update(): void {
		if (!this._service.enabled) {
			this._entry.clear();
			return;
		}

		const entry = this._getEntry();
		if (this._entry.value) {
			this._entry.value.update(entry);
		} else {
			this._entry.value = this._statusbarService.addEntry(entry, 'status.changeReview', StatusbarAlignment.LEFT, 100);
		}
	}

	private _getEntry(): IStatusbarEntry {
		const pendingCount = this._service.pendingFiles.length;
		const requestCount = this._service.requests.length;

		let label: string;
		if (pendingCount > 0) {
			label = pendingCount === 1
				? localize('statusOneFile', "1 File to Review")
				: localize('statusFiles', "{0} Files to Review", pendingCount);
		} else if (this._service.files.length > 0) {
			label = localize('statusReviewed', "All Changes Reviewed");
		} else {
			label = localize('statusNothing', "Nothing to Review");
		}

		if (requestCount > 0) {
			label = requestCount === 1
				? localize('statusOneRequest', "{0}, 1 Request Open", label)
				: localize('statusRequests', "{0}, {1} Requests Open", label, requestCount);
		}

		return {
			name: localize('statusName', "Change Review"),
			text: `${pendingCount > 0 ? '$(checklist)' : '$(pass)'} ${label}`,
			ariaLabel: label,
			tooltip: localize('statusTooltip', "Change Review: unstaged changes are shown inline. Approving a change stages it. Select to go to the next change."),
			command: ChangeReviewCommandId.NextChange,
			kind: pendingCount > 0 ? 'prominent' : undefined
		};
	}
}

registerWorkbenchContribution2(ChangeReviewStatusContribution.ID, ChangeReviewStatusContribution, WorkbenchPhase.AfterRestored);

/** Offers to connect Claude Code for as long as it is not connected. */
class ClaudeConnectionStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.changeReviewClaudeConnection';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IChangeReviewService private readonly _service: IChangeReviewService,
		@IClaudeRecordService private readonly _claudeRecordService: IClaudeRecordService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
	) {
		super();

		this._register(this._service.onDidChange(() => this._update()));
		this._register(this._claudeRecordService.onDidChangeConnection(() => this._update()));
		this._update();
	}

	private _update(): void {
		if (!this._service.enabled || this._claudeRecordService.connectionState !== ClaudeConnectionState.NotConnected) {
			this._entry.clear();
			return;
		}

		if (!this._entry.value) {
			const label = localize('claudeStatusConnect', "Connect Claude Code");
			this._entry.value = this._statusbarService.addEntry({
				name: localize('claudeStatusName', "Claude Code Connection"),
				text: `$(plug) ${label}`,
				ariaLabel: label,
				tooltip: localize('claudeStatusTooltip', "Let the change review mark the changes that Claude Code made"),
				command: ChangeReviewCommandId.ClaudeConnection
			}, 'status.changeReview.claudeConnection', StatusbarAlignment.LEFT, 99);
		}
	}
}

registerWorkbenchContribution2(ClaudeConnectionStatusContribution.ID, ClaudeConnectionStatusContribution, WorkbenchPhase.AfterRestored);

// --- commands

const category = localize2('changeReviewCategory', "Change Review");

/**
 * The shortcuts are the ones upstream uses to keep or undo a chat edit, which this fork has no use for.
 * They act on the highlighted change: the one at the cursor, or else the next one that is not reviewed yet.
 * Outside of macOS the same keys mean redo and new file, so there they only apply inside a change.
 */
const whenCanDecide = ContextKeyExpr.and(
	EditorContextKeys.focus,
	ContextKeyExpr.or(ctxChangeReviewCursorInChange, ContextKeyExpr.and(IsMacContext, ctxChangeReviewHasPendingChanges))
);
const whenHasChanges = ContextKeyExpr.and(ctxChangeReviewHasChanges, EditorContextKeys.focus);
const whenHasPendingChanges = ContextKeyExpr.and(ctxChangeReviewHasPendingChanges, EditorContextKeys.focus);
const keybindingWeight = KeybindingWeight.WorkbenchContrib + 10;

registerAction2(class ApproveChangeAction extends EditorAction2 {
	constructor() {
		super({
			id: ChangeReviewCommandId.ApproveChange,
			title: localize2('approveChange', "Approve Change"),
			category,
			f1: true,
			keybinding: {
				when: whenCanDecide,
				weight: keybindingWeight,
				primary: KeyMod.CtrlCmd | KeyCode.KeyY
			}
		});
	}

	override runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor) {
		return ChangeReviewController.get(editor)?.approve();
	}
});

registerAction2(class RequestChangeAction extends EditorAction2 {
	constructor() {
		super({
			id: ChangeReviewCommandId.RequestChange,
			title: localize2('requestChangeCommand', "Request Change..."),
			category,
			f1: true,
			keybinding: {
				when: whenCanDecide,
				weight: keybindingWeight,
				primary: KeyMod.CtrlCmd | KeyCode.KeyN
			}
		});
	}

	override runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor) {
		return ChangeReviewController.get(editor)?.requestChange();
	}
});

registerAction2(class UndoRequestAction extends EditorAction2 {
	constructor() {
		super({
			id: ChangeReviewCommandId.UndoRequest,
			title: localize2('undoRequestCommand', "Undo Change Request"),
			category,
			f1: true
		});
	}

	override runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor) {
		ChangeReviewController.get(editor)?.undoRequest();
	}
});

registerAction2(class ApproveFileAction extends EditorAction2 {
	constructor() {
		super({
			id: ChangeReviewCommandId.ApproveFile,
			title: localize2('approveFileCommand', "Approve All Changes in File"),
			category,
			f1: true,
			keybinding: {
				when: whenHasPendingChanges,
				weight: keybindingWeight,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyY
			}
		});
	}

	override runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor) {
		return ChangeReviewController.get(editor)?.approveFile();
	}
});

registerAction2(class NextChangeAction extends Action2 {
	constructor() {
		super({
			id: ChangeReviewCommandId.NextChange,
			title: localize2('nextChangeCommand', "Go to Next Change"),
			category,
			f1: true,
			keybinding: {
				when: whenHasChanges,
				weight: keybindingWeight,
				primary: KeyCode.F7
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IChangeReviewService);
		const editor = accessor.get(ICodeEditorService).getActiveCodeEditor();
		const controller = editor ? ChangeReviewController.get(editor) : null;

		// Continue where the reviewer is, or else start with the first file that has something to review
		if (controller?.hasChanges) {
			await controller.goToNextChange();
		} else {
			await service.revealNextFile();
		}
	}
});

registerAction2(class PreviousChangeAction extends EditorAction2 {
	constructor() {
		super({
			id: ChangeReviewCommandId.PreviousChange,
			title: localize2('previousChangeCommand', "Go to Previous Change"),
			category,
			f1: true,
			keybinding: {
				when: whenHasChanges,
				weight: keybindingWeight,
				primary: KeyMod.Shift | KeyCode.F7
			}
		});
	}

	override runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor) {
		ChangeReviewController.get(editor)?.goToPreviousChange();
	}
});

/** Steps to the next or the previous file that still has changes to review. */
class GoToFileAction extends Action2 {

	constructor(private readonly _previous: boolean) {
		super({
			id: _previous ? ChangeReviewCommandId.PreviousFile : ChangeReviewCommandId.NextFile,
			title: _previous
				? localize2('previousFileCommand', "Go to Previous File with Changes")
				: localize2('nextFileCommand', "Go to Next File with Changes"),
			category,
			f1: true,
			keybinding: {
				when: whenHasChanges,
				weight: keybindingWeight,
				primary: _previous ? KeyMod.Alt | KeyMod.Shift | KeyCode.F7 : KeyMod.Alt | KeyCode.F7
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IChangeReviewService);
		const editor = accessor.get(ICodeEditorService).getActiveCodeEditor();
		const controller = editor ? ChangeReviewController.get(editor) : null;

		if (controller) {
			await controller.goToFile(this._previous);
		} else {
			await service.navigateFile(undefined, this._previous);
		}
	}
}

registerAction2(class NextFileAction extends GoToFileAction {
	constructor() {
		super(false);
	}
});

registerAction2(class PreviousFileAction extends GoToFileAction {
	constructor() {
		super(true);
	}
});

registerAction2(class CopyRequestsAction extends Action2 {
	constructor() {
		super({
			id: ChangeReviewCommandId.CopyRequests,
			title: localize2('copyRequestsCommand', "Copy All Open Change Requests"),
			category,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const requests = accessor.get(IChangeReviewService).requests;
		const notificationService = accessor.get(INotificationService);

		if (requests.length === 0) {
			notificationService.status(localize('noRequests', "There are no open change requests."), { hideAfter: 4000 });
			return;
		}

		await accessor.get(IClipboardService).writeText(requests.map(request => request.message).join('\n\n---\n\n'));
		notificationService.status(localize('requestsCopied', "{0} change requests copied to the clipboard.", requests.length), { hideAfter: 4000 });
	}
});

registerAction2(class ToggleChangeReviewAction extends Action2 {
	constructor() {
		super({
			id: ChangeReviewCommandId.Toggle,
			title: localize2('toggleCommand', "Toggle Change Review"),
			category,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const enabled = accessor.get(IChangeReviewService).enabled;
		await accessor.get(IConfigurationService).updateValue(CHANGE_REVIEW_ENABLED_SETTING, !enabled);
	}
});

function describeLastHeard(lastHeard: IClaudeLastHeard | undefined): string {
	if (!lastHeard) {
		return localize('claudeNeverHeard', "Nothing was heard from Claude Code yet. A session that was already running when it was connected may only report after it was restarted.");
	}
	const when = fromNow(lastHeard.time, true, true);
	return lastHeard.entrypoint === 'claude-desktop'
		? localize('claudeLastHeardDesktop', "Last heard from Claude Code {0}, from a session of the desktop app.", when)
		: localize('claudeLastHeard', "Last heard from Claude Code {0}.", when);
}

/** Says how Claude Code is connected to the review, and connects or disconnects it. */
registerAction2(class ClaudeConnectionAction extends Action2 {
	constructor() {
		super({
			id: ChangeReviewCommandId.ClaudeConnection,
			title: localize2('claudeConnectionCommand', "Claude Code Connection..."),
			category,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const claudeRecordService = accessor.get(IClaudeRecordService);
		const dialogService = accessor.get(IDialogService);
		const labelService = accessor.get(ILabelService);
		const notificationService = accessor.get(INotificationService);

		const settingsFile = labelService.getUriLabel(claudeRecordService.settingsFile);
		const state = await claudeRecordService.refreshConnection();

		if (state === ClaudeConnectionState.NotFound) {
			await dialogService.info(
				localize('claudeNotFoundMessage', "Claude Code Was Not Found on This Computer"),
				localize('claudeNotFoundDetail', "Its settings would be in {0}. Start Claude Code once, then try again. If it keeps its settings somewhere else, name the file in the setting {1}.", settingsFile, CLAUDE_SETTINGS_FILE_SETTING)
			);
			return;
		}

		if (state === ClaudeConnectionState.Connected) {
			const { result: disconnect } = await dialogService.prompt<boolean>({
				type: Severity.Info,
				message: localize('claudeConnectedMessage', "Claude Code Is Connected to the Change Review"),
				detail: [
					describeLastHeard(await claudeRecordService.getLastHeard()),
					localize('claudeConnectedDetail', "The review marks the changes that Claude Code made. The hooks that tell it are in {0}.", settingsFile)
				].join('\n\n'),
				buttons: [
					{ label: localize('claudeConnectionOk', "OK"), run: () => false },
					{ label: localize({ key: 'claudeDisconnect', comment: ['&& denotes a mnemonic'] }, "&&Disconnect"), run: () => true }
				]
			});
			if (disconnect) {
				try {
					await claudeRecordService.disconnect();
				} catch (error) {
					notificationService.error(error instanceof ClaudeSettingsError ? error.message : localize('claudeDisconnectFailed', "Claude Code could not be disconnected: {0}", toErrorMessage(error)));
				}
			}
			return;
		}

		const { confirmed } = await dialogService.confirm({
			type: Severity.Info,
			message: localize('claudeConnectMessage', "Connect Claude Code to the Change Review?"),
			detail: localize('claudeConnectDetail', "Claude Code then notes which files it changes, and the review marks those changes as Claude's.\n\nThis adds two hooks to {0}. What they note is kept in {1} and stays on this computer.", settingsFile, labelService.getUriLabel(claudeRecordService.recordFolder)),
			primaryButton: localize({ key: 'claudeConnect', comment: ['&& denotes a mnemonic'] }, "&&Connect")
		});
		if (!confirmed) {
			return;
		}

		try {
			await claudeRecordService.connect();
		} catch (error) {
			notificationService.error(error instanceof ClaudeSettingsError ? error.message : localize('claudeConnectFailed', "Claude Code could not be connected: {0}", toErrorMessage(error)));
			return;
		}
		notificationService.info(localize('claudeConnected', "Claude Code is connected to the change review. A session that is already running may only report its changes after it was restarted."));
	}
});
