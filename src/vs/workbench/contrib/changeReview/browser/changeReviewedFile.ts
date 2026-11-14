/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the reviewed version of a file, and what is still to review in it.
//
// The changes under review are the difference between a file and its reviewed version. The reviewed version is what
// git has staged, plus two things that are on their way into git: what was approved a moment ago, and what the
// reviewer wrote in the editor themselves. Typing, accepting a tab completion, pasting, undoing or formatting needs
// no approval: such an edit goes into the reviewed version as it is made, and is staged when the file is saved. Only
// what reaches the file from outside, such as an edit that Claude Code makes on disk, shows up as a change to review.
//
// One such object exists per file and lives as long as the file is loaded. So all editors of a file agree, and what
// was typed is still known as the reviewer's own after a switch to another tab and back.
//
// What git has staged only counts as reviewed when the reviewer staged it. Claude Code stages and commits too. A
// file whose changes it staged is held under review (see ../common/claudeRecord.ts): its reviewed version is then
// the one from before, kept as a blob of its own, and git is not asked to stage it until the reviewer agreed to
// all there is in the file. Staging less would take out of git what Claude Code put there.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, IReference, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqual } from '../../../../base/common/resources.js';
import { Range } from '../../../../editor/common/core/range.js';
import { DetailedLineRangeMapping, LineRangeMapping, RangeMapping } from '../../../../editor/common/diff/rangeMapping.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IEditorWorkerService } from '../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IModelContentChangedEvent } from '../../../../editor/common/textModelEvents.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IQuickDiffModelService, QuickDiffModel } from '../../scm/browser/quickDiffModel.js';
import { ChangeReviewFileKind, IChangeReviewService } from '../common/changeReview.js';
import { ClaudeConnectionState, IClaudeHold, IClaudeRecordService } from '../common/claudeRecord.js';

/** An edit with one of these origins reaches a file from outside the editor. Everything else is the reviewer's own doing. */
const OUTSIDE_SOURCES: ReadonlySet<string> = new Set(['reloadFromDisk', 'setValue', 'Chat.applyEdits', 'inlineChat.applyEdits']);
const MAX_REMEMBERED_OUTSIDE_CHANGES = 64;

/** Up to this size, the text a file had when it was first seen is kept until git has served the staged version. */
const MAX_FIRST_SIGHT_LENGTH = 2_000_000;
const FIRST_SIGHT_KEPT_MS = 15_000;

/** How long after the reviewer's own edit the changes are computed anew, to make sure they are still what is shown. */
const VERIFY_DELAY_MS = 800;
const DIFF_DELAY_MS = 100;
/** How long until it is looked again whether a shell command of Claude Code, which may have staged the file, has ended. */
const COMMAND_RUNNING_DELAY_MS = 2000;

/** What git answers when it is asked about a blob: its id, its text, or neither. */
interface IBlobAnswer {
	readonly blob?: string;
	readonly text?: string;
}

export class ReviewedFile extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the reviewed version, or what differs from it, is not what it was. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _quickDiffModel = this._register(new MutableDisposable<IReference<QuickDiffModel>>());
	private readonly _quickDiffListener = this._register(new MutableDisposable());

	/** The staged version of the file as git serves it. It follows a change of the index with some delay. */
	private _index: ITextModel | undefined;
	private readonly _indexListener = this._register(new MutableDisposable());
	/** Which state of the staged version was last looked at: git announces changes more often than it has one. */
	private _seenIndex: { readonly model: ITextModel; readonly versionId: number } | undefined;
	private _seenIndexHash: number | undefined;

	private readonly _baseline = this._register(new MutableDisposable<ITextModel>());
	/** Whether the reviewed version is that of a file git has no version of. Such a file started out empty. */
	private _isVirtual = false;
	/** Whether the reviewed version holds something the reviewer wrote that git was not asked to stage yet. */
	private _hasUnstagedOwnEdits = false;

	/** What git was asked to stage. Until it serves that, its staged version is behind and is not taken over. */
	private _expectedIndex: string | undefined;
	/** Whether git has said that it staged {@link _expectedIndex}. It may go on serving an older version for a while. */
	private _isExpectedConfirmed = false;
	/** If git never says whether it staged what it was asked to, staging failed: go back to what it serves. */
	private readonly _giveUpExpectedIndex = this._register(new RunOnceScheduler(() => this._adoptIndex(), 20000));
	/**
	 * What git is believed to have staged: the text it last served, or the one it last said it staged. A text is
	 * only staged on top of this. `undefined` when git has no version of the file.
	 */
	private _gitContents: string | undefined;
	/** The texts that were staged from here lately. Git serves them one after the other, the last one last. */
	private readonly _ownStagedHashes: number[] = [];
	/** Git stages one text at a time. While it does, only the latest of the texts that come up is kept for it. */
	private _stageNext: string | undefined;
	private _isStaging = false;

	private _mappings: readonly LineRangeMapping[] = [];
	/** The versions of the reviewed version and of the file that {@link _mappings} belong to. */
	private _diffVersions: { readonly baseline: number; readonly model: number } | undefined;
	private _diffRequestId = 0;
	private readonly _diffScheduler = this._register(new RunOnceScheduler(() => this._computeDiff(), DIFF_DELAY_MS));
	/** One diff is computed at a time. What changes meanwhile is computed after it, once, however often it changed. */
	private _isComputingDiff = false;
	private _needsDiff = false;

	private _isEnabled: boolean;
	private _isLastChangeFromOutside = true;

	private _alternativeVersionId: number;
	/** The edits that came from outside, as steps of the undo history: undoing or redoing one is not the reviewer's writing. */
	private readonly _outsideChanges: { readonly before: number; readonly after: number }[] = [];

	/**
	 * The text of the file when it was first seen. Git serves the staged version a moment later. If the two are
	 * the same, everything written in between is the reviewer's own.
	 */
	private _firstSight: string | undefined;
	private readonly _forgetFirstSight = this._register(new RunOnceScheduler(() => this._firstSight = undefined, FIRST_SIGHT_KEPT_MS));

	/** Whether it is known which files are held under review. Until then no version is taken as the reviewed one. */
	private _areHoldsKnown = false;
	/** Set while the file is held under review: the reviewed version is not the one git has staged. */
	private _hold: IClaudeHold | undefined;
	/** Whether the reviewed version is that of {@link _hold}. It is not while its blob is being read. */
	private _isHoldApplied = false;
	private _holdRequestId = 0;
	/** The blobs that were written here for the reviewed version. One of them coming back as the hold's is no news. */
	private readonly _writtenBlobs: string[] = [];
	/** The reviewed version of a held file is stored one at a time, the latest one last. */
	private _persistNext: string | undefined;
	private _isPersisting = false;
	private _holdCheckId = 0;
	private _isCheckingHold = false;
	private readonly _checkHoldScheduler = this._register(new RunOnceScheduler(() => this._checkHold(), COMMAND_RUNNING_DELAY_MS));
	/** Git cannot be asked for a while after the window opened. The reviewed version of a held file is read once it can. */
	private readonly _applyHoldScheduler = this._register(new RunOnceScheduler(() => {
		if (this._hold && !this._isHoldApplied) {
			this._applyHold(this._hold);
		}
	}, COMMAND_RUNNING_DELAY_MS));
	private _outsideIndexId = 0;
	private readonly _outsideIndexScheduler = this._register(new RunOnceScheduler(() => this._takeOutsideIndex(), COMMAND_RUNNING_DELAY_MS));

	constructor(
		readonly model: ITextModel,
		@IChangeReviewService private readonly _changeReviewService: IChangeReviewService,
		@IQuickDiffModelService private readonly _quickDiffModelService: IQuickDiffModelService,
		@IEditorWorkerService private readonly _editorWorkerService: IEditorWorkerService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@ICommandService private readonly _commandService: ICommandService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IClaudeRecordService private readonly _claudeRecordService: IClaudeRecordService,
	) {
		super();

		this._isEnabled = this._changeReviewService.enabled;
		this._alternativeVersionId = model.getAlternativeVersionId();
		this._rememberFirstSight();
		this._register(model.onDidChangeContent(e => this._onDidChangeModelContent(e)));
		this._register(this._claudeRecordService.onDidChangeHolds(uri => {
			if (isEqual(uri, model.uri)) {
				this._syncHold();
			}
		}));
		this._claudeRecordService.whenHoldsKnown.then(() => {
			if (!this._store.isDisposed) {
				this._areHoldsKnown = true;
				this._syncHold();
				this._seenIndex = undefined;
				this._onDidChangeIndex();
			}
		});

		this.acquireStagedVersion();
		if (this._isEnabled && !this._baseline.value && model.getValueLength() === 0) {
			// An empty file has nothing to review. What the reviewer goes on to write in it is theirs.
			this._setBaseline('', true);
		}
	}

	/** Whether git was asked to stage something and has not been seen to have it yet. It then still lists the file as before. */
	get isStagePending(): boolean {
		return this._expectedIndex !== undefined || this._isStaging || this._isPersisting || this._isCheckingHold || (this._hold !== undefined && !this._isHoldApplied);
	}

	/**
	 * Whether the last edit of the file came from outside the editor. New changes are only worth being taken to
	 * when they did.
	 */
	get isLastChangeFromOutside(): boolean {
		return this._isLastChangeFromOutside;
	}

	/** What the changes are computed against. `undefined` while git has not served the staged version, or has none. */
	get baseline(): ITextModel | undefined {
		// A held file is reviewed against a version that is being read: what is there until then is not it
		return this._hold && !this._isHoldApplied ? undefined : this._baseline.value;
	}

	/** Which lines of the reviewed version became which lines of the file. Only meaningful while {@link isCurrent}. */
	get mappings(): readonly LineRangeMapping[] {
		return this._mappings;
	}

	/** Whether {@link mappings} describe the file and its reviewed version as they are right now. */
	get isCurrent(): boolean {
		const baseline = this.baseline;
		return !!baseline && this._diffVersions?.baseline === baseline.getVersionId() && this._diffVersions.model === this.model.getVersionId();
	}

	// --- the staged version

	/** Git says through the quick diff which resource holds the staged version. That only works once the file is loaded. */
	acquireStagedVersion(): void {
		if (this._quickDiffModel.value) {
			return;
		}

		const reference = this._quickDiffModelService.createQuickDiffModelReference(this.model.uri);
		if (!reference) {
			return;
		}

		this._quickDiffModel.value = reference;
		this._quickDiffListener.value = reference.object.onDidChange(() => this._syncIndex());
		this._syncIndex();
	}

	private _syncIndex(): void {
		const quickDiffModel = this._quickDiffModel.value?.object;
		const primaryQuickDiff = quickDiffModel?.quickDiffs.find(quickDiff => quickDiff.kind === 'primary');
		const index = primaryQuickDiff ? quickDiffModel?.getDiffEditorModel(primaryQuickDiff.originalResource)?.original : undefined;

		if (index !== this._index) {
			this._index = index;
			this._indexListener.value = index?.onDidChangeContent(() => this._onDidChangeIndex());
		}
		this._onDidChangeIndex();
	}

	private _onDidChangeIndex(): void {
		if (!this._isEnabled || !this._areHoldsKnown) {
			return; // nothing is reviewed, so nothing is kept or computed. Or not yet.
		}

		const index = this._index;
		if (!index || index.isDisposed()) {
			// No staged version: the file is new, ignored, in a conflict, not in a repository, or not known yet
			this._seenIndex = undefined;
			this._seenIndexHash = undefined;
			if (this._hold) {
				this._gitContents = undefined;
				this._checkHold();
				return;
			}
			if (this._baseline.value && !this._isVirtual) {
				this._clearBaseline();
				this._onDidChange.fire();
			}
			return;
		}

		const baseline = this._baseline.value;
		const isSameAsSeen = this._seenIndex?.model === index && this._seenIndex.versionId === index.getVersionId();
		if (baseline && isSameAsSeen) {
			return; // nothing new from git: it announces changes more often than it has one
		}
		this._seenIndex = { model: index, versionId: index.getVersionId() };

		const contents = index.getValue();
		const contentsHash = hash(contents);
		if (this._expectedIndex !== undefined) {
			if (contents === this._expectedIndex) {
				// Git caught up with what was approved or written here
				this._expectedIndex = undefined;
				this._isExpectedConfirmed = false;
				this._giveUpExpectedIndex.cancel();
				this._seenIndexHash = contentsHash;
				this._gitContents = contents;
				if (this._hold) {
					this._checkHold(); // all of a held file was agreed to and is staged now
					return;
				}
				if (baseline) {
					this._isVirtual = false;
					if (baseline.getValue() !== contents) {
						this._hasUnstagedOwnEdits = true; // written since git was asked
						this._stageOwnEdits();
					}
					return;
				}
			} else if (!this._isExpectedConfirmed || this._ownStagedHashes.includes(contentsHash)) {
				return; // git serves an older version: it has not staged yet, or it is on its way through what was staged before
			} else {
				// Git did stage what it was asked to, and now has something else: staged or unstaged by someone else since
				this._expectedIndex = undefined;
				this._isExpectedConfirmed = false;
			}
		}

		if (baseline && !this._isVirtual && this._seenIndexHash === contentsHash) {
			return; // the same staged version, served again
		}
		this._seenIndexHash = contentsHash;
		this._gitContents = contents;

		if (this._hold) {
			// Held under review: the reviewed version is not what git has staged. Whether that goes on is looked at.
			this._checkHold();
			return;
		}

		if (!baseline || this._isVirtual) {
			// The first sight of the staged version. If the file was the same when it was first seen, all that
			// differs now was written here in the meantime, by the reviewer.
			const isOwnSinceFirstSight = this._firstSight !== undefined && this._firstSight === contents;
			const reviewed = isOwnSinceFirstSight || (baseline && baseline.getValue() === this.model.getValue()) ? this.model.getValue() : contents;
			this._firstSight = undefined;
			this._forgetFirstSight.cancel();
			this._setBaseline(reviewed, false);
			this._hasUnstagedOwnEdits = reviewed !== contents;
		} else if (baseline.getValue() !== contents) {
			// Git has another staged version: something was staged or unstaged outside of this editor
			this._takeOutsideIndex();
		}
	}

	/**
	 * Takes over a staged version that was not staged here. When the reviewer staged it in their own git tool, it
	 * counts as reviewed. When Claude Code did, it does not: the script says so once the shell command of Claude
	 * Code has ended, and the file is held then. Until that is known, the reviewed version stays what it is.
	 */
	private async _takeOutsideIndex(): Promise<void> {
		const requestId = ++this._outsideIndexId;
		this._outsideIndexScheduler.cancel();

		let isCommandRunning = false;
		if (this._claudeRecordService.connectionState === ClaudeConnectionState.Connected) {
			try {
				isCommandRunning = await this._claudeRecordService.settle(this.model.uri);
			} catch {
				isCommandRunning = false;
			}
			if (this._store.isDisposed || requestId !== this._outsideIndexId) {
				return;
			}
		}

		if (this._hold) {
			return; // Claude Code staged it, as was found meanwhile
		}
		if (this._claudeRecordService.getHold(this.model.uri)) {
			this._syncHold();
			return;
		}
		if (isCommandRunning) {
			this._outsideIndexScheduler.schedule();
			return;
		}

		const baseline = this._baseline.value;
		const contents = this._gitContents;
		if (!this._isEnabled || !baseline || this._isVirtual || contents === undefined || this._expectedIndex !== undefined) {
			return;
		}
		if (baseline.getValue() !== contents) {
			baseline.setValue(contents);
			this._hasUnstagedOwnEdits = false;
			this._computeDiff();
		}
	}

	// --- held under review: Claude Code staged the file

	/** Follows what is stored about the file being held under review. */
	private _syncHold(): void {
		if (!this._areHoldsKnown) {
			return;
		}

		const before = this._hold;
		const hold = this._isEnabled ? this._claudeRecordService.getHold(this.model.uri) : undefined;
		this._hold = hold;

		if (!hold) {
			if (before) {
				// The reviewer is done with the file, here or in another window. What git has staged counts again.
				this._isHoldApplied = false;
				this._holdRequestId++;
				this._holdCheckId++;
				this._isCheckingHold = false;
				this._checkHoldScheduler.cancel();
				this._applyHoldScheduler.cancel();
				this._persistNext = undefined;
				if (this._isEnabled) {
					if (this._expectedIndex !== undefined) {
						// The reviewed version is what git has staged, as was just found: nothing to take over
						this._seenIndex = undefined;
						this._onDidChangeIndex();
					} else {
						this._adoptIndex();
					}
					this._onDidChange.fire();
				}
			}
			return;
		}

		const isKnownVersion = before !== undefined && this._isHoldApplied && (before.reviewed === hold.reviewed || (hold.reviewed !== null && this._writtenBlobs.includes(hold.reviewed)));
		if (isKnownVersion) {
			this._checkHold(); // Claude Code staged more, or what was agreed to here is stored now
		} else {
			this._applyHold(hold);
		}
	}

	/** Makes the version that the reviewer last agreed to the reviewed one, in place of what git has staged. */
	private async _applyHold(hold: IClaudeHold): Promise<void> {
		const requestId = ++this._holdRequestId;
		const wasApplied = this._isHoldApplied;
		this._applyHoldScheduler.cancel();
		this._isHoldApplied = false;
		this._outsideIndexId++;
		this._outsideIndexScheduler.cancel();
		// What git was asked to stage here does not decide anything anymore
		this._expectedIndex = undefined;
		this._isExpectedConfirmed = false;
		this._stageNext = undefined;
		this._giveUpExpectedIndex.cancel();
		if (wasApplied || this._baseline.value) {
			this._onDidChange.fire(); // nothing is known about the file until its reviewed version is read
		}

		let text: string | undefined;
		if (hold.reviewed !== null) {
			const answer = await this._askGit({ read: hold.reviewed });
			if (this._store.isDisposed || requestId !== this._holdRequestId) {
				return;
			}
			if (!answer) {
				this._applyHoldScheduler.schedule(); // git cannot be asked yet, or failed: nothing is known until it can
				return;
			}
			text = answer.text;
			if (text === undefined) {
				if (hold.original !== undefined && hold.original !== hold.reviewed) {
					// Git cleared away the version that was written for an approval. What was approved shows as a
					// change again: the file is held against the version from before Claude Code staged it.
					this._claudeRecordService.setHoldReviewed(this.model.uri, hold.original);
				} else {
					// Git does not have that version anymore. The file is taken as git has it, as it was before there were holds.
					this._claudeRecordService.releaseHold(this.model.uri);
				}
				return;
			}
		}

		const gitContents = this._gitContents;
		if (text === undefined) {
			// The reviewer never saw a version of the file: all of it is under review, as for a file that is new to git
			if (this._baseline.value) {
				this._clearBaseline();
				this._gitContents = gitContents;
			}
		} else if (this._baseline.value) {
			if (this._baseline.value.getValue() !== text) {
				this._baseline.value.setValue(text);
			}
			this._diffVersions = undefined;
		} else {
			this._setBaseline(text, false);
		}
		this._isVirtual = false;
		this._hasUnstagedOwnEdits = false;
		this._isHoldApplied = true;
		this._computeDiff();
		this._onDidChange.fire();
		this._checkHold();
	}

	private async _askGit(request: { readonly read?: string; readonly write?: string }): Promise<IBlobAnswer | undefined> {
		try {
			return await this._commandService.executeCommand<IBlobAnswer>('git.reviewedBlob', this.model.uri, request);
		} catch {
			return undefined;
		}
	}

	/**
	 * Looks whether the file is still to be held under review, now that git has another staged version or the
	 * reviewer agreed to more of the file.
	 */
	private async _checkHold(): Promise<void> {
		const hold = this._hold;
		if (!hold || !this._isHoldApplied) {
			return;
		}

		const requestId = ++this._holdCheckId;
		this._checkHoldScheduler.cancel();
		this._isCheckingHold = true;
		try {
			const isOutdated = () => this._store.isDisposed || requestId !== this._holdCheckId || this._hold !== hold || !this._isHoldApplied;
			const uri = this.model.uri;

			const answer = await this._askGit({});
			if (isOutdated()) {
				return;
			}
			if (!answer) {
				this._checkHoldScheduler.schedule(); // git cannot be asked yet, or failed
				return;
			}
			const staged = answer.blob ?? null;
			const reviewed = this._baseline.value?.getValue();

			// What git has staged is asked of git itself: the staged version that is served here lags behind
			let isReviewedStaged = staged === null || staged === hold.reviewed;
			if (!isReviewedStaged && staged !== null && reviewed !== undefined) {
				const stagedAnswer = await this._askGit({ read: staged });
				if (isOutdated()) {
					return;
				}
				if (!stagedAnswer) {
					this._checkHoldScheduler.schedule();
					return;
				}
				const stagedText = stagedAnswer.text;
				if (stagedText !== undefined) {
					this._gitContents = stagedText;
					isReviewedStaged = withoutMarks(stagedText) === withoutMarks(reviewed);
				}
			}

			// Git has the reviewed version staged, or no version at all anymore: there is nothing to hold. The
			// file is under review as git lists it.
			if (isReviewedStaged) {
				if (staged !== null && reviewed !== undefined && this._expectedIndex === undefined) {
					// The staged version that is served here may be an older one for a moment yet. It is waited
					// for like one that was staged from here, or what was just agreed to would show again.
					this._expectedIndex = reviewed;
					this._isExpectedConfirmed = true;
					this._giveUpExpectedIndex.schedule();
					if (this._index && !this._index.isDisposed()) {
						this._ownStagedHashes.push(hash(this._index.getValue()));
					}
				}
				await this._claudeRecordService.releaseHold(uri);
				return;
			}

			if (staged !== hold.staged) {
				// Git has something else than Claude Code staged. A shell command of Claude Code that is still
				// running may have staged it: then it says so when it ends.
				const isCommandRunning = await this._claudeRecordService.settle(uri);
				if (isOutdated()) {
					return;
				}
				const current = this._claudeRecordService.getHold(uri);
				if (current?.reviewed !== hold.reviewed || current.staged !== hold.staged) {
					return; // what is stored for the file is not what it was, and is followed
				}
				if (isCommandRunning) {
					this._checkHoldScheduler.schedule();
					return;
				}
				// The reviewer staged the file in their own git tool, after Claude Code did. That counts as reviewed.
				await this._claudeRecordService.releaseHold(uri);
				return;
			}

			// Still held. Once the reviewer agreed to all there is in the file, that is staged, like any approval
			if (reviewed !== undefined && reviewed === this.model.getValue() && this._expectedIndex === undefined && !this._textFileService.isDirty(uri)) {
				this._sendToGit(reviewed);
			}
		} finally {
			if (requestId === this._holdCheckId) {
				this._isCheckingHold = false;
			}
		}
	}

	/**
	 * Stores the reviewed version of a held file as a blob of its own. It is not staged: git has more staged than
	 * the reviewer agreed to, and that would be taken out again.
	 */
	private _persistHold(): void {
		const baseline = this._baseline.value;
		if (!baseline || !this._hold) {
			return;
		}

		this._persistNext = baseline.getValue();
		if (!this._isPersisting) {
			this._persist();
		}
	}

	private async _persist(): Promise<void> {
		this._isPersisting = true;
		try {
			while (this._persistNext !== undefined && this._hold) {
				const contents = this._persistNext;
				this._persistNext = undefined;

				const blob = (await this._askGit({ write: contents }))?.blob;
				if (this._store.isDisposed) {
					return;
				}
				if (blob && this._hold) {
					this._writtenBlobs.push(blob);
					if (this._writtenBlobs.length > 16) {
						this._writtenBlobs.shift();
					}
					await this._claudeRecordService.setHoldReviewed(this.model.uri, blob);
				}
			}
		} finally {
			this._isPersisting = false;
		}
		if (!this._store.isDisposed) {
			this._checkHold();
		}
	}

	private _setBaseline(contents: string, isVirtual: boolean): void {
		const language = this._languageService.createById(this.model.getLanguageId());
		this._baseline.value = this._modelService.createModel(contents, language, undefined, true);
		this._isVirtual = isVirtual;
		this._hasUnstagedOwnEdits = false;
		this._mappings = [];
		this._diffVersions = undefined;
		this._computeDiff();
	}

	/** Takes the staged version as git serves it, whatever was expected of it. */
	private _adoptIndex(): void {
		this._expectedIndex = undefined;
		this._isExpectedConfirmed = false;
		this._stageNext = undefined;
		this._giveUpExpectedIndex.cancel();
		this._seenIndex = undefined;
		this._seenIndexHash = undefined;
		if (this._isVirtual) {
			this._hasUnstagedOwnEdits = true; // git did not take the new file: try again with the next save
		}
		this._onDidChangeIndex();
	}

	private _clearBaseline(): void {
		this._baseline.clear();
		this._isVirtual = false;
		this._hasUnstagedOwnEdits = false;
		this._gitContents = undefined;
		this._expectedIndex = undefined;
		this._isExpectedConfirmed = false;
		this._stageNext = undefined;
		this._giveUpExpectedIndex.cancel();
		this._diffScheduler.cancel();
		this._diffRequestId++;
		this._mappings = [];
		this._diffVersions = undefined;
	}

	private _rememberFirstSight(): void {
		if (this.model.getValueLength() <= MAX_FIRST_SIGHT_LENGTH) {
			this._firstSight = this.model.getValue();
			this._forgetFirstSight.schedule();
		} else {
			this._firstSight = undefined;
		}
	}

	// --- what differs from the reviewed version

	private async _computeDiff(): Promise<void> {
		const model = this.model;
		const baseline = this._baseline.value;
		if (!baseline || model.isDisposed()) {
			return;
		}

		this._diffScheduler.cancel();
		if (this._isComputingDiff) {
			this._needsDiff = true; // the one that is being computed is outdated by now: one more after it
			return;
		}

		const requestId = ++this._diffRequestId;
		const versions = { baseline: baseline.getVersionId(), model: model.getVersionId() };
		this._isComputingDiff = true;
		let result;
		try {
			result = await this._editorWorkerService.computeDiff(baseline.uri, model.uri, { ignoreTrimWhitespace: false, maxComputationTimeMs: 2000, computeMoves: false }, 'advanced');
		} finally {
			this._isComputingDiff = false;
		}
		if (this._store.isDisposed) {
			return;
		}

		const isOutdated = requestId !== this._diffRequestId || this._baseline.value !== baseline
			|| baseline.getVersionId() !== versions.baseline || model.getVersionId() !== versions.model;
		if (this._needsDiff || (isOutdated && !this.isCurrent) || !result) {
			// Something moved on in the meantime, or the diff could not be computed: once more, for how things are now
			this._needsDiff = false;
			if (this._baseline.value && !this.isCurrent) {
				this._diffScheduler.schedule(result ? 0 : 1000);
			}
			return;
		}
		if (isOutdated) {
			return; // the reviewer's own edit went into both versions meanwhile, and the changes were kept up to date with it
		}

		const mappings = result.changes;
		const isSameAsBefore = this.isCurrent && areSameMappings(this._mappings, mappings);
		this._mappings = mappings;
		this._diffVersions = versions;
		if (!isSameAsBefore) {
			this._onDidChange.fire();
		}
	}

	private _onDidChangeModelContent(e: IModelContentChangedEvent): void {
		const previousAlternativeVersionId = this._alternativeVersionId;
		this._alternativeVersionId = this.model.getAlternativeVersionId();
		const isOwn = this._isOwnChange(e, previousAlternativeVersionId);
		this._isLastChangeFromOutside = !isOwn;

		const baseline = this._baseline.value;
		if (!baseline) {
			if (!isOwn && this._forgetFirstSight.isScheduled()) {
				this._rememberFirstSight(); // what came from outside is how the file looks now
			}
			return;
		}

		if (isOwn) {
			this._changeReviewService.reportOwnEdit(this.model.uri);
			if (this._takeOver(e, baseline)) {
				return;
			}
		}

		this._diffScheduler.schedule();
	}

	private _isOwnChange(e: IModelContentChangedEvent, previousAlternativeVersionId: number): boolean {
		const alternativeVersionId = this._alternativeVersionId;

		if (e.isFlush || e.detailedReasons.some(reason => OUTSIDE_SOURCES.has(reason.metadata.source))) {
			this._outsideChanges.push({ before: previousAlternativeVersionId, after: alternativeVersionId });
			if (this._outsideChanges.length > MAX_REMEMBERED_OUTSIDE_CHANGES) {
				this._outsideChanges.shift();
			}
			return false;
		}

		// Undoing what came from outside takes it out of the file again, and redoing it brings it back:
		// neither makes it the reviewer's own
		if (e.isUndoing) {
			return !this._outsideChanges.some(change => change.after === previousAlternativeVersionId && change.before === alternativeVersionId);
		}
		if (e.isRedoing) {
			return !this._outsideChanges.some(change => change.before === previousAlternativeVersionId && change.after === alternativeVersionId);
		}
		return true;
	}

	/**
	 * Makes an edit of the reviewer's part of the reviewed version, where it was made in lines that had no change
	 * under review. An edit inside a change under review stays part of that change.
	 * @returns whether that settles it: {@link mappings} are up to date, and nothing has to be computed
	 */
	private _takeOver(e: IModelContentChangedEvent, baseline: ITextModel): boolean {
		if (this._diffVersions?.baseline !== baseline.getVersionId() || this._diffVersions.model !== e.versionId - 1) {
			return false; // the changes are not known for the state in which this edit was made
		}

		if (e.isEolChange) {
			baseline.setEOL(this.model.getEndOfLineSequence());
		}

		// The ranges of the event are those before the edit, which is the state the mappings describe
		const mappings = this._mappings;
		const edits: { range: Range; text: string }[] = [];
		const shifts: { readonly belowLine: number; readonly lineCount: number }[] = [];
		let isComplete = true;

		for (const change of e.changes) {
			const firstLine = change.range.startLineNumber;
			const lastLine = change.range.endLineNumber;

			// How much further down the same line is in the reviewed version: by what the changes above it removed
			let offset = 0;
			let isInsideChange = false;
			for (const mapping of mappings) {
				if (mapping.modified.endLineNumberExclusive <= firstLine) {
					offset += mapping.original.length - mapping.modified.length;
				} else if (mapping.modified.startLineNumber <= lastLine) {
					isInsideChange = true;
					break;
				} else {
					break; // this change and all further ones are below the edit
				}
			}

			if (isInsideChange) {
				isComplete = false;
				continue;
			}

			edits.push({ range: new Range(firstLine + offset, change.range.startColumn, lastLine + offset, change.range.endColumn), text: change.text });
			const lineCount = countLineBreaks(change.text) - (lastLine - firstLine);
			if (lineCount !== 0) {
				shifts.push({ belowLine: lastLine, lineCount });
			}
		}

		if (edits.length > 0) {
			baseline.applyEdits(edits);
			this._hasUnstagedOwnEdits = true;
		}
		if (!isComplete) {
			return false;
		}

		// The same lines went into both versions, so the changes are what they were. Those below moved along.
		let didMove = false;
		if (shifts.length > 0 && mappings.length > 0) {
			this._mappings = mappings.map(mapping => {
				let lineCount = 0;
				for (const shift of shifts) {
					if (shift.belowLine < mapping.modified.startLineNumber) {
						lineCount += shift.lineCount;
					}
				}
				if (lineCount === 0) {
					return mapping;
				}
				didMove = true;
				return moveMapping(mapping, lineCount);
			});
		}

		this._diffRequestId++;
		this._diffVersions = { baseline: baseline.getVersionId(), model: e.versionId };
		this._diffScheduler.schedule(VERIFY_DELAY_MS);
		if (didMove) {
			this._onDidChange.fire();
		}
		return true;
	}

	// --- into git

	/**
	 * Approves changes: they become part of the reviewed version right away, and git is asked to stage that version.
	 * @returns `false` when the changes are about to be replaced by newly computed ones, and nothing was done
	 */
	approve(mappings: readonly LineRangeMapping[]): boolean {
		const baseline = this.baseline;
		if (!baseline || mappings.length === 0 || !this.isCurrent) {
			return false;
		}

		const baselineLines = baseline.getLinesContent();
		const modelLines = this.model.getLinesContent();
		baseline.applyEdits(mappings.map(mapping => {
			const rangeMapping = mapping.toRangeMapping2(baselineLines, modelLines);
			return { range: rangeMapping.originalRange, text: this.model.getValueInRange(rangeMapping.modifiedRange) };
		}));

		if (this._hold) {
			this._persistHold();
		} else {
			this._sendToGit(baseline.getValue());
		}
		this._computeDiff();
		return true;
	}

	/** The file was saved. What the reviewer wrote in it is on disk now, and can be staged. */
	onDidSave(): void {
		this._stageOwnEdits();
	}

	/**
	 * Something about the review changed: which files git lists, or whether the review is switched on at all.
	 * A new file that the reviewer wrote may be among the listed ones now, and can be staged.
	 */
	onDidChangeReview(): void {
		const isEnabled = this._changeReviewService.enabled;
		if (isEnabled !== this._isEnabled) {
			this._isEnabled = isEnabled;
			if (isEnabled) {
				this._seenIndex = undefined;
				this._syncHold();
				this._onDidChangeIndex();
				if (!this._baseline.value && !this._hold && this.model.getValueLength() === 0) {
					this._setBaseline('', true);
				}
			} else {
				this._hold = undefined;
				this._isHoldApplied = false;
				this._holdRequestId++;
				this._holdCheckId++;
				this._isCheckingHold = false;
				this._outsideIndexId++;
				this._persistNext = undefined;
				this._checkHoldScheduler.cancel();
				this._applyHoldScheduler.cancel();
				this._outsideIndexScheduler.cancel();
				if (this._baseline.value) {
					this._clearBaseline();
				}
			}
			this._onDidChange.fire();
			return;
		}

		if (this._hasUnstagedOwnEdits && this._isVirtual) {
			this._stageOwnEdits();
		}
	}

	private _stageOwnEdits(): void {
		const baseline = this._baseline.value;
		if (!baseline || !this._hasUnstagedOwnEdits || this._expectedIndex !== undefined || !this._isEnabled || this._textFileService.isDirty(this.model.uri)) {
			return;
		}

		if (this._hold) {
			// What the reviewer wrote in a held file is theirs as well, and is kept with what they agreed to
			this._hasUnstagedOwnEdits = false;
			this._persistHold();
			return;
		}

		const index = this._index && !this._index.isDisposed() ? this._index : undefined;
		if (!index && this._changeReviewService.getFile(this.model.uri)?.kind !== ChangeReviewFileKind.Added) {
			return; // git does not list the file: it has not noticed it yet, or it ignores it
		}

		const contents = baseline.getValue();
		if (this._gitContents !== undefined ? this._gitContents === contents : contents.length === 0) {
			this._hasUnstagedOwnEdits = false;
			return;
		}
		this._sendToGit(contents);
	}

	private _sendToGit(contents: string): void {
		this._expectedIndex = contents;
		this._isExpectedConfirmed = false;
		this._hasUnstagedOwnEdits = false;
		this._ownStagedHashes.push(hash(contents));
		if (this._ownStagedHashes.length > 16) {
			this._ownStagedHashes.shift();
		}
		this._giveUpExpectedIndex.schedule();

		this._stageNext = contents;
		if (!this._isStaging) {
			this._stage();
		}
	}

	private async _stage(): Promise<void> {
		this._isStaging = true;
		try {
			while (this._stageNext !== undefined) {
				const contents = this._stageNext;
				this._stageNext = undefined;

				// Git only stages the text if it still has the staged version this text was built on. It says what it
				// has instead when not, and nothing when it failed.
				let result: true | { readonly actual: string | undefined } | undefined;
				try {
					result = await this._commandService.executeCommand<true | { readonly actual: string | undefined }>('git.stageContent', this.model.uri, contents, { base: this._gitContents });
				} catch {
					result = undefined;
				}
				if (this._store.isDisposed) {
					return;
				}

				if (result === true) {
					this._gitContents = contents;
					if (this._expectedIndex === contents) {
						this._isExpectedConfirmed = true;
						this._giveUpExpectedIndex.cancel();
					}
					this._noteOwnStaging();
					continue;
				}

				// Not staged. What was approved or written here shows as a change again, against what git really has.
				const baseline = this._baseline.value;
				if (this._hold) {
					// Unless the file is held: what was agreed to is kept by itself then, and stays agreed to
					this._expectedIndex = undefined;
					this._isExpectedConfirmed = false;
					this._stageNext = undefined;
					this._giveUpExpectedIndex.cancel();
					this._checkHoldScheduler.schedule();
				} else if (result && typeof result.actual === 'string' && baseline) {
					this._expectedIndex = undefined;
					this._isExpectedConfirmed = false;
					this._stageNext = undefined;
					this._giveUpExpectedIndex.cancel();
					this._gitContents = result.actual;
					this._seenIndexHash = hash(result.actual);
					this._isVirtual = false;
					this._hasUnstagedOwnEdits = false;
					if (baseline.getValue() !== result.actual) {
						baseline.setValue(result.actual);
						this._computeDiff();
					}
				} else {
					this._adoptIndex();
				}
				return;
			}
		} finally {
			this._isStaging = false;
		}
	}

	/**
	 * Says what was staged here, for the script of Claude Code to tell it from what Claude Code staged: an approval
	 * that is staged while a shell command of Claude Code runs is among what that command is seen to have changed.
	 */
	private async _noteOwnStaging(): Promise<void> {
		if (this._claudeRecordService.connectionState !== ClaudeConnectionState.Connected) {
			return;
		}
		const blob = (await this._askGit({}))?.blob;
		if (blob && !this._store.isDisposed) {
			await this._claudeRecordService.noteOwnStaging(this.model.uri, blob);
		}
	}
}

/** A text without what does not survive a text model unchanged: a byte order mark, and which line endings it has. */
function withoutMarks(text: string): string {
	return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function countLineBreaks(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text.charCodeAt(index);
		if (character === 10 /* \n */) {
			count++;
		} else if (character === 13 /* \r */ && text.charCodeAt(index + 1) !== 10) {
			count++;
		}
	}
	return count;
}

function moveMapping(mapping: LineRangeMapping, lineCount: number): LineRangeMapping {
	const innerChanges = mapping instanceof DetailedLineRangeMapping
		? mapping.innerChanges?.map(inner => new RangeMapping(inner.originalRange.delta(lineCount), inner.modifiedRange.delta(lineCount)))
		: undefined;
	return new DetailedLineRangeMapping(mapping.original.delta(lineCount), mapping.modified.delta(lineCount), innerChanges);
}

function areSameMappings(a: readonly LineRangeMapping[], b: readonly LineRangeMapping[]): boolean {
	return a.length === b.length && a.every((mapping, index) => mapping.original.equals(b[index].original) && mapping.modified.equals(b[index].modified));
}

export const IChangeReviewFilesService = createDecorator<IChangeReviewFilesService>('changeReviewFilesService');

export interface IChangeReviewFilesService {
	readonly _serviceBrand: undefined;

	/** The reviewed version of the file that a text model holds. `undefined` for what is not a file. */
	get(model: ITextModel): ReviewedFile | undefined;
}

export class ChangeReviewFilesService extends Disposable implements IChangeReviewFilesService {

	declare readonly _serviceBrand: undefined;

	private readonly _files = new ResourceMap<ReviewedFile>();

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IModelService modelService: IModelService,
		@ITextFileService textFileService: ITextFileService,
		@IChangeReviewService changeReviewService: IChangeReviewService,
	) {
		super();

		this._register(modelService.onModelRemoved(model => {
			const file = this._files.get(model.uri);
			if (file?.model === model) {
				this._files.delete(model.uri);
				file.dispose();
			}
		}));
		this._register(textFileService.files.onDidResolve(e => this._files.get(e.model.resource)?.acquireStagedVersion()));
		this._register(textFileService.files.onDidSave(e => this._files.get(e.model.resource)?.onDidSave()));
		this._register(changeReviewService.onDidChange(() => {
			for (const file of this._files.values()) {
				file.onDidChangeReview();
			}
		}));
		this._register(toDisposable(() => {
			for (const file of this._files.values()) {
				file.dispose();
			}
			this._files.clear();
		}));
	}

	get(model: ITextModel): ReviewedFile | undefined {
		if (model.isDisposed() || (model.uri.scheme !== Schemas.file && model.uri.scheme !== Schemas.vscodeRemote)) {
			return undefined;
		}

		let file = this._files.get(model.uri);
		if (file && file.model !== model) {
			file.dispose();
			file = undefined;
		}
		if (!file) {
			file = this._instantiationService.createInstance(ReviewedFile, model);
			this._files.set(model.uri, file);
		}
		return file;
	}
}
