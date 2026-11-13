/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: change review. Unstaged changes are shown inline in the editor and reviewed one by one.
// Approving a change stages it in git, so "unstaged" always means "not reviewed yet".

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IChangeReviewService = createDecorator<IChangeReviewService>('changeReviewService');

export const CHANGE_REVIEW_ENABLED_SETTING = 'changeReview.enabled';
export const CHANGE_REVIEW_AUTO_REVEAL_SETTING = 'changeReview.autoReveal';

export const enum ChangeReviewCommandId {
	ApproveChange = 'changeReview.approveChange',
	RequestChange = 'changeReview.requestChange',
	UndoRequest = 'changeReview.undoRequest',
	ApproveFile = 'changeReview.approveFile',
	NextChange = 'changeReview.goToNextChange',
	PreviousChange = 'changeReview.goToPreviousChange',
	NextFile = 'changeReview.goToNextFile',
	PreviousFile = 'changeReview.goToPreviousFile',
	CopyRequests = 'changeReview.copyRequests',
	Toggle = 'changeReview.toggle',
}

/** Set on an editor that shows changes under review, flagged ones included. */
export const ctxChangeReviewHasChanges = new RawContextKey<boolean>('changeReviewHasChanges', false, localize('changeReviewHasChanges', "Whether the editor shows changes under review"));
/** Set on an editor that shows at least one change that is neither approved nor flagged. */
export const ctxChangeReviewHasPendingChanges = new RawContextKey<boolean>('changeReviewHasPendingChanges', false, localize('changeReviewHasPendingChanges', "Whether the editor shows changes that are not reviewed yet"));
/** Set on an editor whose cursor is inside a change under review. */
export const ctxChangeReviewCursorInChange = new RawContextKey<boolean>('changeReviewCursorInChange', false, localize('changeReviewCursorInChange', "Whether the cursor is inside a change under review"));

export const enum ChangeReviewFileKind {
	/** A tracked file with unstaged edits. Its changes are reviewed one by one. */
	Modified,
	/** A new, untracked file. It is reviewed as a whole. */
	Added,
	/** A file that was deleted in the working tree. The deletion is reviewed as a whole. */
	Deleted
}

export interface IChangeReviewFile {
	/** The file in the working tree. For a deleted file this is where it used to be. */
	readonly uri: URI;
	/** What an editor shows for this file: the file itself, or the last committed version of a deleted file. */
	readonly editorUri: URI;
	readonly kind: ChangeReviewFileKind;
}

/** A change the reviewer did not approve. The message is what was copied to the clipboard. */
export interface IChangeReviewRequest {
	readonly uri: URI;
	/** Identifies the change inside its file by content, so it survives line shifts. */
	readonly key: string;
	readonly message: string;
}

export interface IChangeReviewService {
	readonly _serviceBrand: undefined;

	/** Fires when the files, the open requests or the enablement change. */
	readonly onDidChange: Event<void>;

	readonly enabled: boolean;
	readonly autoReveal: boolean;

	/** All files with unstaged changes. */
	readonly files: readonly IChangeReviewFile[];
	/** The files that still have changes which are neither approved nor flagged. */
	readonly pendingFiles: readonly IChangeReviewFile[];
	readonly requests: readonly IChangeReviewRequest[];

	/** Looks a file up by what an editor shows for it. */
	getFile(editorUri: URI): IChangeReviewFile | undefined;

	hasRequest(uri: URI, key: string): boolean;
	addRequest(request: IChangeReviewRequest): void;
	removeRequest(uri: URI, key: string): void;
	/** Drops the requests of a file whose change no longer exists. */
	retainRequests(uri: URI, keys: ReadonlySet<string>): void;

	/** Editors report how many changes of a file are still neither approved nor flagged. */
	setPendingCount(uri: URI, count: number): void;

	/**
	 * Opens the next file that still has changes to review and reveals its first one.
	 * @param after the file the reviewer just finished; it is skipped.
	 * @returns `false` when no such file is left.
	 */
	revealNextFile(after?: URI): Promise<boolean>;

	/**
	 * Steps through the files that still have changes to review, and wraps around at either end.
	 * @param from the file the reviewer is in.
	 */
	navigateFile(from: URI | undefined, previous: boolean): Promise<void>;
}

export const CHANGE_REVIEW_EDITOR_CONTRIBUTION_ID = 'editor.contrib.changeReview';

/**
 * What an editor that shows changes under review can do. Implemented by the editor contribution
 * registered as {@link CHANGE_REVIEW_EDITOR_CONTRIBUTION_ID}; the service only needs it to hand
 * over after it opened a file.
 */
export interface IChangeReviewEditor extends IEditorContribution {
	/** Reveals the first change that is not reviewed yet, as soon as the changes are known. */
	revealFirstPendingChange(): void;
}
