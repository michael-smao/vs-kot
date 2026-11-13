/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/changeReview.css';

import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { raceTimeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { safeIntl } from '../../../../base/common/date.js';
import { Emitter } from '../../../../base/common/event.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { StableEditorScrollState } from '../../../../editor/browser/stableEditorScroll.js';
import { EmbeddedCodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/embeddedCodeEditorWidget.js';
import { LineSource, renderLines, RenderOptions } from '../../../../editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { DetailedLineRangeMapping, LineRangeMapping } from '../../../../editor/common/diff/rangeMapping.js';
import { IEditorContribution, IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { IModelDeltaDecoration, ITextModel } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { InlineDecoration, InlineDecorationType } from '../../../../editor/common/viewModel/inlineDecorations.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CHANGE_REVIEW_EDITOR_CONTRIBUTION_ID, ChangeReviewCommandId, ChangeReviewFileKind, ctxChangeReviewCursorInChange, ctxChangeReviewHasChanges, ctxChangeReviewHasPendingChanges, IChangeReviewEditor, IChangeReviewService } from '../common/changeReview.js';
import { findClaudeEntry, IClaudeRecordEntry, IClaudeRecordService } from '../common/claudeRecord.js';
import { IChangeReviewFilesService, ReviewedFile } from './changeReviewedFile.js';

// --- colors: brighter than the diff editor's, since here they sit inside the code that is being read

registerColor('changeReview.addedLineBackground',
	{ dark: '#3ddc8440', light: '#2db66a40', hcDark: '#3ddc8440', hcLight: '#2db66a40' },
	localize('changeReview.addedLineBackground', "Background color of lines that an unreviewed change added."));
registerColor('changeReview.addedTextBackground',
	{ dark: '#3ddc8470', light: '#2db66a70', hcDark: '#3ddc8470', hcLight: '#2db66a70' },
	localize('changeReview.addedTextBackground', "Background color of the text that an unreviewed change added inside a line."));
registerColor('changeReview.removedLineBackground',
	{ dark: '#ff5a5a47', light: '#f0484840', hcDark: '#ff5a5a47', hcLight: '#f0484840' },
	localize('changeReview.removedLineBackground', "Background color of lines that an unreviewed change removed."));
registerColor('changeReview.removedTextBackground',
	{ dark: '#ff5a5a80', light: '#f0484870', hcDark: '#ff5a5a80', hcLight: '#f0484870' },
	localize('changeReview.removedTextBackground', "Background color of the text that an unreviewed change removed inside a line."));

const addedLineDecoration = ModelDecorationOptions.register({
	description: 'change-review-line-added',
	className: 'change-review-line-added',
	isWholeLine: true
});
const removedLineDecoration = ModelDecorationOptions.register({
	description: 'change-review-line-removed',
	className: 'change-review-line-removed',
	isWholeLine: true
});
const addedTextDecoration = ModelDecorationOptions.register({
	description: 'change-review-text-added',
	className: 'change-review-text-added',
	shouldFillLineOnLineBreak: true
});
const REMOVED_TEXT_CLASS_NAME = 'change-review-text-removed';

/** Removed lines stack above the first line of their change, behind anything else that sits there. */
const REMOVED_ZONE_ORDINAL = 10000;
const WHOLE_FILE_KEY = 'file';
/** A removed block shows this many lines at most. Thousands of them would be built and laid out for nothing. */
const MAX_REMOVED_LINES_SHOWN = 300;
/** How long a file may be listed by git as changed with nothing to show for it, before it is offered as a whole. */
const WHOLE_FILE_FALLBACK_MS = 4000;

interface IReviewHunk {
	/** Identifies the change by its content, so a flag survives line shifts but not a rewrite. */
	readonly key: string;
	/**
	 * What is reviewed as a whole, or `undefined` for a single change inside a modified file. A modified file is
	 * reviewed as a whole when git lists it as changed but no line of it can be shown as changed.
	 */
	readonly wholeFile: ChangeReviewFileKind | undefined;
	/** Which lines of the reviewed version became which lines of the file. */
	readonly mapping: LineRangeMapping | undefined;
	/** The first editor line of the change. For removed lines: the line that follows them. */
	readonly startLineNumber: number;
	/** The last editor line of the change. */
	readonly endLineNumber: number;
	/** Whether the reviewer asked for this change to be redone. */
	readonly flagged: boolean;
	/** What says that Claude Code made this change. `undefined` when nothing on record says so. */
	readonly claude: IClaudeRecordEntry | undefined;
}

/** What a change says about where it comes from, next to its buttons. */
interface IReviewOrigin {
	readonly label: string;
	readonly title: string;
}

interface IReviewButton {
	readonly label: string;
	readonly title: string;
	readonly primary: boolean;
	run(): void;
}

export class ChangeReviewController extends Disposable implements IEditorContribution, IChangeReviewEditor {

	static readonly ID = CHANGE_REVIEW_EDITOR_CONTRIBUTION_ID;

	static get(editor: ICodeEditor): ChangeReviewController | null {
		return editor.getContribution<ChangeReviewController>(ChangeReviewController.ID);
	}

	private readonly _modelStore = this._register(new DisposableStore());
	private readonly _widgetStore = this._register(new DisposableStore());
	private readonly _bar = this._register(new MutableDisposable<ChangeReviewBarWidget>());
	private readonly _decorations: IEditorDecorationsCollection;
	private _viewZoneIds: string[] = [];
	private _widgets: ChangeReviewHunkWidget[] = [];

	private _hunks: IReviewHunk[] = [];

	/**
	 * The reviewed version of the file, and what differs from it. It belongs to the file, not to this editor:
	 * see {@link ReviewedFile}.
	 */
	private _reviewed: ReviewedFile | undefined;
	/** Which changes are drawn right now, and where. Drawing the same again would only make the editor flicker. */
	private _renderedSignature: string | undefined;
	/**
	 * Git lists a file as changed although no line of it is, or serves no staged text of it: its mode or its line
	 * endings changed, or it is a link. If that stays so, there is still something to approve: the file as a whole.
	 */
	private readonly _wholeFileFallback = this._register(new RunOnceScheduler(() => this._showAsWholeFile(), WHOLE_FILE_FALLBACK_MS));
	private _isShownAsWholeFile = false;
	/** A file that is reviewed as a whole grows and shrinks while it is written: its extent is taken anew then. */
	private readonly _wholeFileRefresh = this._register(new RunOnceScheduler(() => this._update(), 150));
	/** How many lines each change removed. They are shown above the change and take up room there. */
	private _removedHeights = new Map<IReviewHunk, number>();
	/** Whether {@link _hunks} are the computed changes of a file, and not just "nothing yet". */
	private _isKnown = false;
	private _lastPendingCount: number | undefined;
	private _revealWhenKnown = false;
	/** Fires when {@link _hunks} were replaced by a newly computed set. */
	private readonly _onDidComputeHunks = this._register(new Emitter<void>());

	private _isUpdating = false;
	private _serviceSignature = '';

	private readonly _ctxHasChanges: IContextKey<boolean>;
	private readonly _ctxHasPendingChanges: IContextKey<boolean>;
	private readonly _ctxCursorInChange: IContextKey<boolean>;

	constructor(
		private readonly _editor: ICodeEditor,
		@IChangeReviewService private readonly _service: IChangeReviewService,
		@IChangeReviewFilesService private readonly _filesService: IChangeReviewFilesService,
		@IEditorService private readonly _editorService: IEditorService,
		@ICommandService private readonly _commandService: ICommandService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILabelService private readonly _labelService: ILabelService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IClaudeRecordService private readonly _claudeRecordService: IClaudeRecordService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();

		this._decorations = this._editor.createDecorationsCollection();
		this._ctxHasChanges = ctxChangeReviewHasChanges.bindTo(contextKeyService);
		this._ctxHasPendingChanges = ctxChangeReviewHasPendingChanges.bindTo(contextKeyService);
		this._ctxCursorInChange = ctxChangeReviewCursorInChange.bindTo(contextKeyService);

		this._register(this._editor.onDidChangeModel(() => this._onDidChangeModel()));
		this._register(this._editor.onDidChangeCursorPosition(() => this._updateCursorState()));
		this._register(this._editor.onDidScrollChange(() => this._layoutWidgets()));
		this._register(this._editor.onDidLayoutChange(() => {
			this._layoutWidgets();
			this._bar.value?.layout();
		}));
		this._register(this._service.onDidChange(() => this._onDidChangeService()));
		this._register(this._editor.onDidChangeConfiguration(e => {
			if (e.hasChanged(EditorOption.fontInfo) || e.hasChanged(EditorOption.lineHeight) || e.hasChanged(EditorOption.wrappingInfo)) {
				this._redraw(); // the removed lines are drawn here, not by the editor: with the old font otherwise
			}
		}));
		this._register(toDisposable(() => this._clearRendering()));

		this._onDidChangeModel();
	}

	// --- state

	private _onDidChangeModel(): void {
		this._modelStore.clear();
		this._reviewed = undefined;
		this._hunks = [];
		this._renderedSignature = undefined;
		this._wholeFileFallback.cancel();
		this._wholeFileRefresh.cancel();
		this._isShownAsWholeFile = false;
		this._isKnown = false;
		this._lastPendingCount = undefined;
		this._revealWhenKnown = false;
		this._clearRendering();
		this._ctxHasChanges.set(false);
		this._ctxHasPendingChanges.set(false);
		this._ctxCursorInChange.set(false);

		const model = this._editor.getModel();
		if (!model) {
			this._updateBar();
			return;
		}

		this._modelStore.add(model.onDidChangeContent(() => {
			if (this._hunks[0]?.wholeFile !== undefined) {
				this._wholeFileRefresh.schedule();
			}
		}));
		this._modelStore.add(model.onDidChangeOptions(() => this._redraw())); // the tab size
		this._modelStore.add(this._claudeRecordService.onDidChangeRecord(uri => {
			if (isEqual(uri, this._getFileUri(model))) {
				this._update(); // what is on record for this file says who made its changes
			}
		}));
		this._serviceSignature = this._getServiceSignature(model);
		this._update();
		// A file that is still to be reviewed has its bar right away, see _getBarState
		this._updateBar();
	}

	/**
	 * The reviewed version of the file is only asked for by an editor that shows the review. A diff editor or a
	 * peek does not, and neither does anything while the review is switched off: nothing is computed for them.
	 */
	private _ensureReviewed(model: ITextModel): ReviewedFile | undefined {
		if (!this._reviewed && this._isReviewEditor()) {
			this._reviewed = this._filesService.get(model);
			if (this._reviewed) {
				this._modelStore.add(this._reviewed.onDidChange(() => this._update()));
			}
		}
		return this._reviewed;
	}

	/** Draws everything anew, although the changes are the same. */
	private _redraw(): void {
		this._renderedSignature = undefined;
		this._update();
	}

	private _showAsWholeFile(): void {
		this._isShownAsWholeFile = true;
		this._update();
	}

	/** Approves changes of a modified file: they become part of its reviewed version, which git is asked to stage. */
	private _approve(hunks: readonly IReviewHunk[]): boolean {
		const mappings = hunks.map(hunk => hunk.mapping).filter(mapping => !!mapping);
		return !!this._reviewed?.approve(mappings);
	}

	/** Everything the service knows that changes which changes this editor shows. */
	private _getServiceSignature(model: ITextModel): string {
		const file = this._service.getFile(model.uri);
		const fileUri = file?.uri ?? model.uri;
		const flagged = this._service.requests.filter(request => isEqual(request.uri, fileUri)).map(request => request.key);
		return `${this._service.enabled}|${file?.kind}|${flagged.join(',')}`;
	}

	private _onDidChangeService(): void {
		const model = this._editor.getModel();
		if (!model || this._isUpdating) {
			return;
		}

		const signature = this._getServiceSignature(model);
		if (signature !== this._serviceSignature) {
			this._serviceSignature = signature;
			this._update();
		} else {
			this._reportPendingCount(model);
			this._updateBar(); // it also shows how many files are left
		}
	}

	/**
	 * Tells the service how many changes of this file are still open. The service forgets that whenever the file
	 * is written, which also happens when the reviewer saves what they wrote themselves.
	 */
	private _reportPendingCount(model: ITextModel): void {
		const file = this._service.getFile(model.uri);
		if (!file || !this._isKnown) {
			return;
		}

		this._isUpdating = true;
		try {
			this._service.setPendingCount(file.uri, this._getPendingHunks().length);
		} finally {
			this._isUpdating = false;
		}
	}

	private _isReviewEditor(): boolean {
		return this._service.enabled
			&& !this._editor.getOption(EditorOption.inDiffEditor)
			&& !(this._editor instanceof EmbeddedCodeEditorWidget);
	}

	/** The file in the working tree that this editor is about. */
	private _getFileUri(model: ITextModel): URI {
		return this._service.getFile(model.uri)?.uri ?? model.uri;
	}

	private _update(): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		if (!this._isReviewEditor()) {
			this._setHunks(model, [], false);
			return;
		}

		const reviewed = this._ensureReviewed(model);
		const file = this._service.getFile(model.uri);
		const wholeFile = (kind: ChangeReviewFileKind): IReviewHunk[] => [{
			key: WHOLE_FILE_KEY,
			wholeFile: kind,
			mapping: undefined,
			startLineNumber: 1,
			endLineNumber: model.getLineCount(),
			flagged: this._service.hasRequest(file?.uri ?? model.uri, WHOLE_FILE_KEY),
			// A new file is all added lines, and the editor of a deleted file shows the lines that are gone
			claude: kind === ChangeReviewFileKind.Added ? findClaudeEntry(this._claudeRecordService.getEntries(file?.uri ?? model.uri), model.getLinesContent(), [])
				: kind === ChangeReviewFileKind.Deleted ? findClaudeEntry(this._claudeRecordService.getEntries(file?.uri ?? model.uri), [], model.getLinesContent())
					: undefined
		}];

		// A new or a deleted file is reviewed as a whole
		if (file && file.kind !== ChangeReviewFileKind.Modified) {
			this._wholeFileFallback.cancel();
			this._isShownAsWholeFile = false;

			// Unless it is a new file that the reviewer wrote here themselves: there is nothing to review in that
			if (file.kind === ChangeReviewFileKind.Added && reviewed?.baseline) {
				if (!reviewed.isCurrent) {
					return; // what differs from what the reviewer wrote is being computed
				}
				if (reviewed.mappings.length === 0) {
					this._setHunks(model, [], true);
					return;
				}
			}

			this._setHunks(model, wholeFile(file.kind), true);
			return;
		}

		// A modified file is reviewed change by change, against its reviewed version
		const baseline = reviewed?.baseline;
		const hasNothingToShow = !reviewed || !baseline || (reviewed.isCurrent && reviewed.mappings.length === 0);
		if (file && hasNothingToShow && !reviewed?.isStagePending) {
			// Git lists the file as changed, and yet no line of it is. Right after an approval that is only git
			// being behind. Otherwise there is something that cannot be shown: see _wholeFileFallback.
			if (this._isShownAsWholeFile) {
				this._setHunks(model, wholeFile(ChangeReviewFileKind.Modified), true);
				return;
			}
			if (!this._wholeFileFallback.isScheduled()) {
				this._wholeFileFallback.schedule();
			}
		} else {
			this._wholeFileFallback.cancel();
			this._isShownAsWholeFile = false;
		}

		if (!reviewed || !baseline) {
			this._setHunks(model, [], false);
			return;
		}
		if (!reviewed.isCurrent) {
			return; // the changes for what the editor shows right now are on their way
		}

		const fileUri = this._getFileUri(model);
		const claudeEntries = this._claudeRecordService.getEntries(fileUri);
		const lineCount = model.getLineCount();
		const occurrences = new Map<string, number>();
		const hunks = reviewed.mappings.map((mapping): IReviewHunk => {
			const originalLines = mapping.original.mapToLineArray(lineNumber => baseline.getLineContent(lineNumber));
			const modifiedLines = mapping.modified.mapToLineArray(lineNumber => model.getLineContent(lineNumber));
			const contentHash = hash([originalLines.join('\n'), modifiedLines.join('\n')]).toString(36);
			const occurrence = occurrences.get(contentHash) ?? 0;
			occurrences.set(contentHash, occurrence + 1);
			const key = `${contentHash}.${occurrence}`;

			const startLineNumber = mapping.modified.startLineNumber;
			return {
				key,
				wholeFile: undefined,
				mapping,
				startLineNumber,
				endLineNumber: mapping.modified.isEmpty ? Math.min(startLineNumber, lineCount) : mapping.modified.endLineNumberExclusive - 1,
				flagged: this._service.hasRequest(fileUri, key),
				claude: findClaudeEntry(claudeEntries, modifiedLines, originalLines)
			};
		});

		this._setHunks(model, hunks, true);
	}

	private _setHunks(model: ITextModel, hunks: IReviewHunk[], isKnown: boolean): void {
		// Drawing takes down and puts up every removed block and every widget. Changes that are drawn already, at
		// the same lines, are left alone: they are computed again after every edit, and nothing should flicker then.
		const signature = hunks.map(hunk => `${hunk.key}@${hunk.startLineNumber}-${hunk.endLineNumber}${hunk.flagged ? '!' : ''}${hunk.wholeFile ?? ''}${hunk.claude ? `*${hunk.claude.time}` : ''}`).join(' ');
		const isDrawn = signature === this._renderedSignature;
		if (!isDrawn) {
			this._hunks = hunks; // the widgets belong to these objects: keep the drawn ones otherwise
		}
		this._isKnown = isKnown;

		const pendingCount = hunks.filter(hunk => !hunk.flagged).length;
		this._ctxHasChanges.set(hunks.length > 0);
		this._ctxHasPendingChanges.set(pendingCount > 0);

		if (!isDrawn) {
			this._renderedSignature = signature;
			this._render(model);
		}
		if (hunks.length === 0) {
			this._ctxCursorInChange.set(false); // or the keys of a change would stay taken where there is none anymore
		}

		if (!isKnown) {
			return;
		}

		// Tell the service where this file stands. Right after the last change of a file is staged,
		// git may already have dropped the file from its list: then there is nothing to tell.
		const file = this._service.getFile(model.uri);
		if (file) {
			this._isUpdating = true;
			try {
				this._service.retainRequests(file.uri, new Set(hunks.map(hunk => hunk.key)));
				this._service.setPendingCount(file.uri, pendingCount);
			} finally {
				this._isUpdating = false;
				this._serviceSignature = this._getServiceSignature(model);
			}
			this._updateBar();
		}

		const previousPendingCount = this._lastPendingCount;
		this._lastPendingCount = pendingCount;
		this._onDidComputeHunks.fire();

		if (pendingCount === 0) {
			if (this._revealWhenKnown) {
				// The reviewer was taken here for changes, and there are none to decide about: on to the next file
				this._revealWhenKnown = false;
				this._service.revealNextFile(this._getFileUri(model));
			}
			return;
		}

		// New changes showed up in a file that was done: jump to them, unless the reviewer is typing there.
		// Only changes that came from outside count: the reviewer's own edits are not news to them.
		const hasNewChanges = previousPendingCount === 0 && this._service.autoReveal && (this._reviewed?.isLastChangeFromOutside ?? true)
			&& this._editorService.activeTextEditorControl === this._editor && !this._getHunkAtCursor();
		if (this._revealWhenKnown || hasNewChanges) {
			this._revealWhenKnown = false;
			this._reveal(this._getPendingHunks()[0]);
		}
	}

	private _getPendingHunks(): IReviewHunk[] {
		return this._hunks.filter(hunk => !hunk.flagged);
	}

	private _getHunkAtCursor(): IReviewHunk | undefined {
		const lineNumber = this._editor.getPosition()?.lineNumber;
		if (lineNumber === undefined) {
			return undefined;
		}
		return this._hunks.find(hunk => lineNumber >= Math.min(hunk.startLineNumber, hunk.endLineNumber) && lineNumber <= hunk.endLineNumber);
	}

	/** The change a command acts on: the one at the cursor, or else the next one that is not reviewed yet. */
	private _getCurrentHunk(): IReviewHunk | undefined {
		const atCursor = this._getHunkAtCursor();
		if (atCursor) {
			return atCursor;
		}
		const lineNumber = this._editor.getPosition()?.lineNumber ?? 1;
		const pending = this._getPendingHunks();
		return pending.find(hunk => this._getRevealLine(hunk) > lineNumber) ?? pending[0];
	}

	/** The line the cursor is put on for a change. Lines removed at the very end of the file belong to a line that is not there. */
	private _getRevealLine(hunk: IReviewHunk): number {
		return Math.min(hunk.startLineNumber, this._editor.getModel()?.getLineCount() ?? hunk.startLineNumber);
	}

	private _updateCursorState(): void {
		this._ctxCursorInChange.set(!!this._getHunkAtCursor());
		const current = this._getCurrentHunk();
		for (const widget of this._widgets) {
			widget.setCurrent(widget.hunk === current);
		}
		this._updateBar();
	}

	get hasChanges(): boolean {
		return this._hunks.length > 0;
	}

	// --- rendering

	/** Takes the changes out of the editor. The bar is not part of them, see {@link _updateBar}. */
	private _clearRendering(): void {
		this._widgetStore.clear();
		this._widgets = [];
		this._removedHeights.clear();
		this._decorations.clear();
		if (this._viewZoneIds.length > 0) {
			this._editor.changeViewZones(accessor => {
				for (const id of this._viewZoneIds) {
					accessor.removeZone(id);
				}
			});
			this._viewZoneIds = [];
		}
	}

	private _render(model: ITextModel): void {
		if (this._hunks.length === 0) {
			this._clearRendering();
			this._updateBar();
			return;
		}

		this._widgetStore.clear();
		this._removedHeights = new Map();

		const original = this._reviewed?.baseline;
		const lineCount = model.getLineCount();
		const decorations: IModelDeltaDecoration[] = [];

		// The removed blocks take up room above what the reviewer is looking at: keep that where it is
		const scrollState = StableEditorScrollState.capture(this._editor);

		// Where the removed lines wrap, when the editor wraps lines
		const lineBreaksComputer = original ? this._editor._getViewModel()?.createLineBreaksComputer({
			getLineContent: lineNumber => original.getLineContent(lineNumber),
			getLineInjectedText: () => null
		}) : undefined;
		const shownRemovedLines = (hunk: IReviewHunk) => hunk.mapping ? Math.min(hunk.mapping.original.length, MAX_REMOVED_LINES_SHOWN) : 0;
		if (lineBreaksComputer) {
			for (const hunk of this._hunks) {
				for (let index = 0; hunk.mapping && index < shownRemovedLines(hunk); index++) {
					lineBreaksComputer.addRequest(hunk.mapping.original.startLineNumber + index, null);
				}
			}
		}
		const lineBreaks = lineBreaksComputer?.finalize() ?? [];
		let lineBreakIndex = 0;

		this._editor.changeViewZones(accessor => {
			for (const id of this._viewZoneIds) {
				accessor.removeZone(id);
			}
			this._viewZoneIds = [];

			const renderOptions = RenderOptions.fromEditor(this._editor);

			for (const hunk of this._hunks) {
				const mapping = hunk.mapping;

				if (hunk.wholeFile !== undefined) {
					if (hunk.wholeFile !== ChangeReviewFileKind.Modified) {
						decorations.push({
							range: new Range(1, 1, lineCount, model.getLineMaxColumn(lineCount)),
							options: hunk.wholeFile === ChangeReviewFileKind.Added ? addedLineDecoration : removedLineDecoration
						});
					}
					continue;
				}

				if (!mapping || !original) {
					continue;
				}

				const isModification = !mapping.original.isEmpty && !mapping.modified.isEmpty;
				const innerChanges = isModification && mapping instanceof DetailedLineRangeMapping ? mapping.innerChanges ?? [] : [];

				// Added lines are part of the file: tint them green
				if (!mapping.modified.isEmpty) {
					decorations.push({ range: mapping.modified.toInclusiveRange()!, options: addedLineDecoration });
					for (const innerChange of innerChanges) {
						if (!innerChange.modifiedRange.isEmpty() && mapping.modified.contains(innerChange.modifiedRange.startLineNumber)) {
							decorations.push({ range: innerChange.modifiedRange, options: addedTextDecoration });
						}
					}
				}

				// Removed lines are not part of the file anymore: show them in red above
				if (!mapping.original.isEmpty) {
					const shownLineCount = shownRemovedLines(hunk);
					const firstLine = mapping.original.startLineNumber;
					const shownLines = Array.from({ length: shownLineCount }, (_, index) => firstLine + index);
					original.tokenization.forceTokenization(firstLine + shownLineCount - 1);
					const source = new LineSource(
						shownLines.map(lineNumber => original.tokenization.getLineTokens(lineNumber)),
						shownLines.map(() => lineBreaks[lineBreakIndex++] ?? null),
						original.mightContainNonBasicASCII(),
						original.mightContainRTL()
					);
					const inlineDecorations = innerChanges
						.filter(innerChange => !innerChange.originalRange.isEmpty() && innerChange.originalRange.endLineNumber < firstLine + shownLineCount)
						.map(innerChange => new InlineDecoration(
							innerChange.originalRange.delta(-(mapping.original.startLineNumber - 1)),
							REMOVED_TEXT_CLASS_NAME,
							InlineDecorationType.Regular
						));

					const domNode = $('.change-review-removed-zone.view-lines.monaco-mouse-cursor-text');
					const result = renderLines(source, renderOptions, inlineDecorations, domNode);
					let heightInLines = result.heightInLines;
					if (shownLineCount < mapping.original.length) {
						append(domNode, $('.change-review-removed-more', undefined, localize('moreRemovedLines', "{0} more removed lines", mapping.original.length - shownLineCount)));
						heightInLines++;
					}
					this._removedHeights.set(hunk, heightInLines);

					this._viewZoneIds.push(accessor.addZone({
						afterLineNumber: Math.min(hunk.startLineNumber - 1, lineCount),
						heightInLines,
						// so that a long removed line can be scrolled to, as far as the lines of the file can
						minWidthInPx: result.minWidthInPx,
						domNode,
						ordinal: REMOVED_ZONE_ORDINAL
					}));
				}
			}
		});

		this._decorations.set(decorations);
		scrollState.restore(this._editor);

		// A file that is reviewed as a whole has its buttons in the bar, a single change has them right below it
		this._widgets = this._hunks
			.filter(hunk => hunk.wholeFile === undefined)
			.map(hunk => this._widgetStore.add(new ChangeReviewHunkWidget(
				this._editor,
				hunk,
				this._removedHeights.get(hunk) ?? 0,
				hunk.flagged ? localize('changeRequested', "Change Requested") : undefined,
				hunk.claude ? getClaudeOrigin(hunk.claude) : undefined,
				this._getHunkButtons(hunk),
				this._hoverService
			)));

		this._updateCursorState();
	}

	private _getKeybindingLabel(commandId: string): string | undefined {
		return this._keybindingService.lookupKeybinding(commandId)?.getLabel() ?? undefined;
	}

	private _withKeybinding(text: string, commandId: string): string {
		const keybinding = this._getKeybindingLabel(commandId);
		return keybinding ? localize('textWithKeybinding', "{0} ({1})", text, keybinding) : text;
	}

	/** A button says which key does the same, the way a menu item does. */
	private _withKeybindingHint(label: string, commandId: string): string {
		const keybinding = this._getKeybindingLabel(commandId);
		return keybinding ? localize('labelWithKeybinding', "{0} {1}", label, keybinding) : label;
	}

	private _getHunkButtons(hunk: IReviewHunk): IReviewButton[] {
		const approve: IReviewButton = {
			label: this._withKeybindingHint(localize('approve', "Approve"), ChangeReviewCommandId.ApproveChange),
			title: localize('approveTitle', "Approve this change and stage it in git"),
			primary: true,
			run: () => this.approve(hunk)
		};

		if (hunk.flagged) {
			return [{
				label: localize('undoRequest', "Undo Request"),
				title: localize('undoRequestTitle', "Take the change request back"),
				primary: false,
				run: () => this.undoRequest(hunk)
			}, approve];
		}

		return [{
			label: this._withKeybindingHint(localize('requestChange', "Request Change"), ChangeReviewCommandId.RequestChange),
			title: localize('requestChangeTitle', "Copy a note about this change to the clipboard, to paste it into Claude Code"),
			primary: false,
			run: () => this.requestChange(hunk)
		}, approve];
	}

	private _layoutWidgets(): void {
		for (const widget of this._widgets) {
			widget.layout();
		}
	}

	/** Shows the bar, brings it up to date, or takes it away. Nothing else decides whether there is a bar. */
	private _updateBar(): void {
		const model = this._editor.getModel();
		const state = model ? this._getBarState(model) : undefined;
		if (!state) {
			this._bar.clear();
			return;
		}

		if (!this._bar.value) {
			this._bar.value = new ChangeReviewBarWidget(this._editor, {
				previousChange: () => this.goToPreviousChange(),
				nextChange: () => this.goToNextChange(),
				requestChange: () => this.requestChange(),
				undoRequest: () => this.undoRequest(),
				approveFile: () => this.approveFile(),
				previousFile: () => this.goToFile(true),
				nextFile: () => this.goToFile(false)
			}, {
				previousChange: this._withKeybinding(localize('previousChangeTitle', "Previous Change"), ChangeReviewCommandId.PreviousChange),
				nextChange: this._withKeybinding(localize('nextChangeTitle', "Next Change"), ChangeReviewCommandId.NextChange),
				requestChange: localize('requestChangeFileTitle', "Copy a note about this file to the clipboard, to paste it into Claude Code"),
				undoRequest: localize('undoRequestTitle', "Take the change request back"),
				approveFile: localize('approveFileTitle', "Approve all changes in this file that have no open request, and stage them in git"),
				previousFile: this._withKeybinding(localize('previousFileTitle', "Previous File with Changes to Review"), ChangeReviewCommandId.PreviousFile),
				nextFile: this._withKeybinding(localize('nextFileTitle', "Next File with Changes to Review"), ChangeReviewCommandId.NextFile)
			});
		}
		this._bar.value.update(state);
	}

	/** What the bar shows for the file in the editor, or `undefined` when the file gets no bar. */
	private _getBarState(model: ITextModel): IBarState | undefined {
		const fileUri = this._getFileUri(model);
		const pendingFiles = this._service.pendingFiles;
		const fileIndex = pendingFiles.findIndex(file => isEqual(file.uri, fileUri));

		// A file that is still to be reviewed has its bar before its changes are computed, so that
		// stepping through the files does not have to wait for them
		const isLoading = this._hunks.length === 0 && !this._isKnown && fileIndex !== -1 && this._isReviewEditor();
		if (this._hunks.length === 0 && !isLoading) {
			return undefined;
		}

		const pending = this._getPendingHunks();
		const wholeFile = this._hunks.length > 0 && this._hunks[0].wholeFile !== undefined ? this._hunks[0] : undefined;

		// A counter keeps its width while it counts, and with that the arrows around it keep their place,
		// in this file and in the next one. It has room for the largest count there was so far.
		widestCounts.changes = Math.max(widestCounts.changes, pending.length);
		widestCounts.files = Math.max(widestCounts.files, pendingFiles.length);
		const changeOf = (index: number, count: number) => localize('changeOf', "{0} of {1}", index, count);
		const fileOf = (index: number, count: number) => localize('fileOf', "File {0} of {1}", index, count);
		const filesLeft = (count: number) => localize('filesLeft', "{0} Files Left", count);
		const noFilesLeft = localize('noFilesLeft', "No Files Left");

		// The arrows that step through the changes are only there when there is something to step through,
		// or will be in a moment. Without them the label can say what it likes: no arrow moves for it.
		const hasChangeArrows = !wholeFile && (isLoading || pending.length > 0);

		let changeLabel: string;
		if (wholeFile) {
			changeLabel = wholeFile.flagged ? localize('changeRequested', "Change Requested")
				: wholeFile.wholeFile === ChangeReviewFileKind.Added ? localize('newFile', "New File")
					: wholeFile.wholeFile === ChangeReviewFileKind.Deleted ? localize('deletedFile', "Deleted File")
						: localize('changedFile', "Changed, No Lines to Show");
			if (wholeFile.claude && !wholeFile.flagged) {
				// No arrows are around this label (see hasChangeArrows), so it may be longer for one file than for another
				changeLabel = localize('labelWithOrigin', "{0} · {1}", changeLabel, getClaudeOrigin(wholeFile.claude).label);
			}
		} else if (isLoading) {
			changeLabel = '';
		} else {
			const current = this._getCurrentHunk();
			const index = current ? pending.indexOf(current) : -1;
			changeLabel = index !== -1 ? changeOf(index + 1, pending.length)
				: pending.length === 1 ? localize('oneChange', "1 Change")
					: pending.length > 1 ? localize('changes', "{0} Changes", pending.length)
						: localize('allRequested', "All Requested");
		}

		const fileLabel = fileIndex !== -1 ? fileOf(fileIndex + 1, pendingFiles.length)
			: pendingFiles.length === 0 ? noFilesLeft
				: pendingFiles.length === 1 ? localize('oneFileLeft', "1 File Left")
					: filesLeft(pendingFiles.length);

		return {
			changeLabel,
			widestChangeLabels: hasChangeArrows ? [changeOf(widestCounts.changes, widestCounts.changes)] : [],
			hasChangeArrows,
			canNavigateChanges: !wholeFile && pending.length > 0,
			isWholeFile: !!wholeFile,
			isFlagged: !!wholeFile?.flagged,
			canApproveFile: !!wholeFile || pending.length > 0,
			approveFileLabel: this._withKeybindingHint(localize('approveFile', "Approve File"), wholeFile ? ChangeReviewCommandId.ApproveChange : ChangeReviewCommandId.ApproveFile),
			requestChangeLabel: this._withKeybindingHint(localize('requestChange', "Request Change"), ChangeReviewCommandId.RequestChange),
			fileLabel,
			widestFileLabels: [fileOf(widestCounts.files, widestCounts.files), filesLeft(widestCounts.files), noFilesLeft],
			canNavigateFiles: pendingFiles.some(file => !isEqual(file.uri, fileUri))
		};
	}

	// --- navigation

	revealFirstPendingChange(): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		if (!this._isKnown) {
			this._revealWhenKnown = true;
			return;
		}

		const first = this._getPendingHunks()[0];
		if (first) {
			this._reveal(first);
		} else if (this._service.getFile(model.uri)) {
			// Nothing to decide about in this file after all: say so, and go on to the next one
			this._service.setPendingCount(this._getFileUri(model), 0);
			this._service.revealNextFile(this._getFileUri(model));
		}
	}

	private _reveal(hunk: IReviewHunk): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const lineCount = model.getLineCount();
		const lineNumber = Math.min(hunk.startLineNumber, lineCount);
		this._editor.setPosition({ lineNumber, column: 1 });

		// Show the start of the change, with the line below it where its buttons hang
		const lastLineNumber = Math.min(Math.max(hunk.endLineNumber, lineNumber) + 1, lineNumber + 20, lineCount);
		this._editor.revealLinesInCenterIfOutsideViewport(lineNumber, lastLineNumber);

		// The removed lines sit above the first line: bring them into view as well
		const removedHeight = this._removedHeights.get(hunk) ?? 0;
		if (removedHeight > 0 && hunk.startLineNumber <= lineCount) {
			const lineHeight = this._editor.getOption(EditorOption.lineHeight);
			const removedTop = this._editor.getTopForLineNumber(lineNumber) - removedHeight * lineHeight - this._editor.getScrollTop();
			if (removedTop < 0) {
				this._editor.setScrollTop(this._editor.getScrollTop() + removedTop - lineHeight);
			}
		}
	}

	/** An approval shows once the editor has fewer changes than before. */
	private async _waitForFewerHunks(hunkCountBefore: number): Promise<boolean> {
		if (this._hunks.length < hunkCountBefore) {
			return true;
		}

		const store = new DisposableStore();
		try {
			const didChange = new Promise<boolean>(resolve => store.add(this._onDidComputeHunks.event(() => {
				if (this._hunks.length < hunkCountBefore) {
					resolve(true);
				}
			})));
			return await raceTimeout(didChange, 4000) ?? false;
		} finally {
			store.dispose();
		}
	}

	/** The change with a key, once the changes are computed for what the editor shows now. */
	private async _waitForHunk(key: string): Promise<IReviewHunk | undefined> {
		const store = new DisposableStore();
		try {
			await raceTimeout(new Promise<void>(resolve => store.add(this._onDidComputeHunks.event(() => resolve()))), 2000);
		} finally {
			store.dispose();
		}
		return this._reviewed?.isCurrent ? this._hunks.find(hunk => hunk.key === key) : undefined;
	}

	/** After a decision the review moves on: to the next change below, or else to the next file. */
	private _advanceAfter(model: ITextModel, afterLine: number): void {
		if (this._editor.getModel() !== model) {
			return; // the reviewer went somewhere else in the meantime
		}

		const pending = this._getPendingHunks();
		const next = pending.find(hunk => hunk.startLineNumber > afterLine) ?? pending[0];
		if (next) {
			this._reveal(next);
			this._editor.focus();
		} else {
			this._service.revealNextFile(this._getFileUri(model));
		}
	}

	async goToNextChange(): Promise<void> {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const lineNumber = this._editor.getPosition()?.lineNumber ?? 1;
		const pending = this._getPendingHunks();
		const next = pending.find(hunk => this._getRevealLine(hunk) > lineNumber);
		if (next) {
			this._reveal(next);
			this._editor.focus();
			return;
		}

		// Nothing below the cursor: continue in the next file, or start over in this one
		const fileUri = this._getFileUri(model);
		const hasOtherFiles = this._service.pendingFiles.some(file => !isEqual(file.uri, fileUri));
		if (pending.length > 0 && !hasOtherFiles) {
			this._reveal(pending[0]);
			this._editor.focus();
		} else {
			await this._service.revealNextFile(fileUri);
		}
	}

	goToPreviousChange(): void {
		const lineNumber = this._editor.getPosition()?.lineNumber ?? 1;
		const pending = this._getPendingHunks();
		const previous = pending.findLast(hunk => hunk.endLineNumber < lineNumber) ?? pending.at(-1);
		if (previous) {
			this._reveal(previous);
			this._editor.focus();
		}
	}

	async goToFile(previous: boolean): Promise<void> {
		const model = this._editor.getModel();
		await this._service.navigateFile(model ? this._getFileUri(model) : undefined, previous);
	}

	// --- decisions

	/** Approving stages the change in git. What is staged counts as reviewed. */
	async approve(hunk: IReviewHunk | undefined = this._getCurrentHunk()): Promise<void> {
		const model = this._editor.getModel();
		if (!model || !hunk) {
			return;
		}

		this._editor.focus();
		const fileUri = this._getFileUri(model);

		if (hunk.wholeFile !== undefined) {
			await this._commandService.executeCommand('git.stageFile', model.uri);
			this._service.removeRequest(fileUri, hunk.key);
			this._service.setPendingCount(fileUri, 0);
			await this._service.revealNextFile(fileUri);
			return;
		}

		if (this._reviewed && !this._reviewed.isCurrent) {
			// The changes are being computed anew, after an edit. The click was made on this change: wait for it.
			const key = hunk.key;
			hunk = await this._waitForHunk(key);
			if (!hunk || this._editor.getModel() !== model) {
				return;
			}
		}

		const hunkCountBefore = this._hunks.length;
		if (this._approve([hunk]) && await this._waitForFewerHunks(hunkCountBefore)) {
			this._advanceAfter(model, hunk.startLineNumber);
		}
	}

	/** Approves every change of the file that has no open request. */
	async approveFile(): Promise<void> {
		const model = this._editor.getModel();
		if (!model || this._hunks.length === 0) {
			return;
		}

		const wholeFile = this._hunks.find(hunk => hunk.wholeFile !== undefined);
		if (wholeFile) {
			await this.approve(wholeFile);
			return;
		}

		this._editor.focus();
		const hunkCountBefore = this._hunks.length;
		if (this._approve(this._getPendingHunks()) && await this._waitForFewerHunks(hunkCountBefore) && this._editor.getModel() === model) {
			await this._service.revealNextFile(this._getFileUri(model));
		}
	}

	/**
	 * Not approving a change copies a note about it to the clipboard, to paste it into Claude Code.
	 * The change stays unstaged and is skipped until it is rewritten.
	 */
	async requestChange(hunk: IReviewHunk | undefined = this._getCurrentHunk()): Promise<void> {
		const model = this._editor.getModel();
		if (!model || !hunk) {
			return;
		}

		const fileUri = this._getFileUri(model);
		const passage = this._describe(model, fileUri, hunk);

		const note = await this._quickInputService.input({
			title: localize('requestChangeInputTitle', "Request Change"),
			prompt: localize('requestChangeInputPrompt', "What should be different? Your note is copied to the clipboard together with the passage."),
			placeHolder: localize('requestChangeInputPlaceholder', "Optional note, for example: keep the old name")
		});
		if (note === undefined) {
			return; // cancelled
		}

		const message = note.trim() ? `${passage}\n\n${note.trim()}` : passage;
		await this._clipboardService.writeText(message);
		this._notificationService.status(localize('requestCopied', "Change request copied to the clipboard."), { hideAfter: 4000 });

		// Flagging the change updates what this editor shows right away
		this._service.addRequest({ uri: fileUri, key: hunk.key, message });
		this._advanceAfter(model, hunk.startLineNumber);
	}

	undoRequest(hunk: IReviewHunk | undefined = this._getHunkAtCursor()): void {
		const model = this._editor.getModel();
		if (model && hunk?.flagged) {
			this._service.removeRequest(this._getFileUri(model), hunk.key);
			this._editor.focus();
		}
	}

	/** Says which passage a change request is about, in a form Claude Code can act on. */
	private _describe(model: ITextModel, fileUri: URI, hunk: IReviewHunk): string {
		const path = this._labelService.getUriLabel(fileUri, { relative: true });

		if (hunk.wholeFile === ChangeReviewFileKind.Added) {
			return localize('describeAdded', "I don't like the new file {0}.", path);
		}
		if (hunk.wholeFile === ChangeReviewFileKind.Deleted) {
			return localize('describeDeleted', "I don't like that {0} was deleted.", path);
		}
		if (hunk.wholeFile === ChangeReviewFileKind.Modified) {
			return localize('describeChanged', "I don't like the change to {0}. Git lists it as changed, but none of its lines is: its mode, its line endings or what it links to.", path);
		}

		const lines = hunk.startLineNumber === hunk.endLineNumber
			? localize('describeLine', "line {0}", hunk.startLineNumber)
			: localize('describeLines', "lines {0}-{1}", hunk.startLineNumber, hunk.endLineNumber);

		const mapping = hunk.mapping;
		const original = this._reviewed?.baseline;
		const removed = mapping && original ? mapping.original.mapToLineArray(lineNumber => `-${original.getLineContent(lineNumber)}`) : [];
		const added = mapping ? mapping.modified.mapToLineArray(lineNumber => `+${model.getLineContent(lineNumber)}`) : [];

		return [
			localize('describeChange', "I don't like this change in {0} ({1}):", path, lines),
			'',
			'```diff',
			...removed,
			...added,
			'```'
		].join('\n');
	}
}

const recordTimeFormat = safeIntl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** How a change that Claude Code made says so. */
function getClaudeOrigin(entry: IClaudeRecordEntry): IReviewOrigin {
	const time = recordTimeFormat.value.format(new Date(entry.time));
	return {
		label: localize('originClaude', "Claude"),
		title: entry.isWithoutLines ? localize('originClaudeFileTitle', "Claude Code changed this file on {0}. Which lines it changed is not on record.", time)
			: entry.tool === 'Bash' ? localize('originClaudeShellTitle', "A shell command of Claude Code made this change on {0}.", time)
				: localize('originClaudeTitle', "Claude Code made this change on {0}.", time)
	};
}

function createButton(container: HTMLElement, store: DisposableStore, button: IReviewButton, supportIcons = false): Button {
	const element = store.add(new Button(container, { ...defaultButtonStyles, secondary: !button.primary, title: button.title, supportIcons }));
	element.label = button.label;
	store.add(element.onDidClick(() => button.run()));
	return element;
}

/** The buttons of one change. They hang below its bottom right corner. */
class ChangeReviewHunkWidget extends Disposable implements IOverlayWidget {

	private static _idPool = 0;
	private readonly _id = `change-review-hunk-widget-${ChangeReviewHunkWidget._idPool++}`;

	private readonly _domNode: HTMLElement;
	private _position: IOverlayWidgetPosition | null = null;
	private _width = 0;
	private _isInView: boolean | undefined;

	constructor(
		private readonly _editor: ICodeEditor,
		readonly hunk: IReviewHunk,
		private readonly _removedHeightInLines: number,
		label: string | undefined,
		origin: IReviewOrigin | undefined,
		buttons: readonly IReviewButton[],
		hoverService: IHoverService
	) {
		super();

		this._domNode = $('.change-review-hunk-widget');
		this._domNode.classList.toggle('flagged', hunk.flagged);

		if (origin) {
			const element = append(this._domNode, $('span.change-review-origin', undefined, origin.label));
			this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), element, origin.title));
		}
		if (label) {
			append(this._domNode, $('span.change-review-label', undefined, label));
		}
		for (const button of buttons) {
			createButton(this._domNode, this._store, button);
		}

		this._editor.addOverlayWidget(this);
		this._register(toDisposable(() => this._editor.removeOverlayWidget(this)));
		this.layout();
	}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return this._position;
	}

	setCurrent(isCurrent: boolean): void {
		this._domNode.classList.toggle('current', isCurrent);
	}

	layout(): void {
		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		const lineHeight = this._editor.getOption(EditorOption.lineHeight);
		const layoutInfo = this._editor.getLayoutInfo();
		const lineCount = model.getLineCount();
		const mapping = this.hunk.mapping;

		// Where the change ends: below its last added line, or below the removed lines when it added none
		let bottom: number;
		if (mapping && !mapping.modified.isEmpty) {
			bottom = this._editor.getBottomForLineNumber(this.hunk.endLineNumber);
		} else if (this.hunk.startLineNumber > lineCount) {
			bottom = this._editor.getBottomForLineNumber(lineCount) + this._removedHeightInLines * lineHeight;
		} else {
			bottom = this._editor.getTopForLineNumber(this.hunk.startLineNumber);
		}

		// Scrolling calls this for every change of the file. Only the few in view are measured and placed.
		const top = bottom - this._editor.getScrollTop();
		const isInView = top > -lineHeight && top < layoutInfo.height;
		if (!isInView) {
			if (this._isInView !== false) {
				this._isInView = false;
				this._domNode.style.visibility = 'hidden';
			}
			return;
		}

		this._isInView = true;
		this._domNode.style.visibility = '';
		if (this._width === 0) {
			this._width = this._domNode.offsetWidth; // zero while the editor itself is hidden: measured again then
		}
		const left = layoutInfo.contentLeft + layoutInfo.contentWidth - layoutInfo.verticalScrollbarWidth - this._width - 12;
		this._position = { preference: { top, left: Math.max(layoutInfo.contentLeft, left) } };
		this._editor.layoutOverlayWidget(this);
	}
}

interface IBarActions {
	previousChange(): void;
	nextChange(): void;
	requestChange(): void;
	undoRequest(): void;
	approveFile(): void;
	previousFile(): void;
	nextFile(): void;
}

type IBarTitles = { readonly [action in keyof IBarActions]: string };

interface IBarState {
	readonly changeLabel: string;
	/** The widest texts {@link changeLabel} takes on between its arrows. The label reserves their width. */
	readonly widestChangeLabels: readonly string[];
	/** Whether the arrows that step through the changes are there at all. */
	readonly hasChangeArrows: boolean;
	readonly canNavigateChanges: boolean;
	/** A new or a deleted file: there are no single changes, the bar decides about the file. */
	readonly isWholeFile: boolean;
	readonly isFlagged: boolean;
	readonly canApproveFile: boolean;
	readonly approveFileLabel: string;
	readonly requestChangeLabel: string;
	readonly fileLabel: string;
	/** The widest texts {@link fileLabel} takes on between its arrows. The label reserves their width. */
	readonly widestFileLabels: readonly string[];
	readonly canNavigateFiles: boolean;
}

/**
 * The largest counts the bar had to show so far, and two digits at least. A counter keeps room for
 * them, also once the count is smaller again, so that its arrows never move back and forth.
 */
const widestCounts = { changes: 10, files: 10 };

/**
 * How far to the right of the editor's middle the bar ends. About half the width of the bar, which
 * makes it sit in the middle; what matters is that it is the same for every file.
 */
const BAR_END_FROM_MIDDLE = 215;
/** The room the bar keeps to the bottom of the editor, and to its right side when the editor is narrow. */
const BAR_MARGIN = 16;

/**
 * Floats at the bottom of an editor that shows changes under review: steps through changes and files.
 *
 * Its buttons stay where they are from one file to the next, so that a reviewer can click through the
 * files without looking for them again. For that the bar hangs by its right end on a point that only
 * depends on the size of the editor, and whatever differs between files makes it longer or shorter at
 * its left end.
 */
class ChangeReviewBarWidget extends Disposable implements IOverlayWidget {

	private static _idPool = 0;
	private readonly _id = `change-review-bar-widget-${ChangeReviewBarWidget._idPool++}`;

	/** The point the bar hangs on. It has no size of its own. */
	private readonly _domNode: HTMLElement;
	private _position: IOverlayWidgetPosition | null = null;

	private readonly _changeSection: HTMLElement;
	private readonly _previousChange: Button;
	private readonly _nextChange: Button;
	private readonly _changeLabel: HTMLElement;
	private readonly _requestChange: Button;
	private readonly _undoRequest: Button;
	private readonly _approveFile: Button;
	private readonly _previousFile: Button;
	private readonly _nextFile: Button;
	private readonly _fileLabel: HTMLElement;

	constructor(
		private readonly _editor: ICodeEditor,
		actions: IBarActions,
		titles: IBarTitles
	) {
		super();

		this._domNode = $('.change-review-bar-anchor');
		const bar = append(this._domNode, $('.change-review-bar-widget'));
		const iconButton = (container: HTMLElement, icon: string, action: keyof IBarActions) => {
			const button = createButton(container, this._store, { label: `$(${icon})`, title: titles[action], primary: false, run: () => actions[action]() }, true);
			button.element.classList.add('change-review-icon-button');
			return button;
		};

		this._changeSection = append(bar, $('.change-review-bar-section'));
		this._previousChange = iconButton(this._changeSection, 'arrow-up', 'previousChange');
		this._changeLabel = append(this._changeSection, $('span.change-review-label'));
		this._nextChange = iconButton(this._changeSection, 'arrow-down', 'nextChange');

		const decisionSection = append(bar, $('.change-review-bar-section'));
		this._requestChange = createButton(decisionSection, this._store, { label: '', title: titles.requestChange, primary: false, run: () => actions.requestChange() });
		this._undoRequest = createButton(decisionSection, this._store, { label: localize('undoRequest', "Undo Request"), title: titles.undoRequest, primary: false, run: () => actions.undoRequest() });
		this._approveFile = createButton(decisionSection, this._store, { label: '', title: titles.approveFile, primary: true, run: () => actions.approveFile() });

		// The buttons that step through the files come last: they are next to the end the bar hangs by
		const fileSection = append(bar, $('.change-review-bar-section'));
		this._previousFile = iconButton(fileSection, 'arrow-left', 'previousFile');
		this._fileLabel = append(fileSection, $('span.change-review-label'));
		this._nextFile = iconButton(fileSection, 'arrow-right', 'nextFile');

		this._editor.addOverlayWidget(this);
		this._register(toDisposable(() => this._editor.removeOverlayWidget(this)));
		this.layout();
	}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IOverlayWidgetPosition | null {
		return this._position;
	}

	update(state: IBarState): void {
		// The label takes the width of its widest text: one line each, none of them shown (see the CSS)
		this._changeLabel.textContent = state.changeLabel;
		this._changeLabel.dataset.widest = state.widestChangeLabels.join('\n');
		this._previousChange.element.style.display = state.hasChangeArrows ? '' : 'none';
		this._nextChange.element.style.display = state.hasChangeArrows ? '' : 'none';
		this._previousChange.enabled = state.canNavigateChanges;
		this._nextChange.enabled = state.canNavigateChanges;
		this._changeSection.classList.toggle('flagged', state.isFlagged);

		this._requestChange.label = state.requestChangeLabel;
		this._requestChange.element.style.display = state.isWholeFile && !state.isFlagged ? '' : 'none';
		this._undoRequest.element.style.display = state.isWholeFile && state.isFlagged ? '' : 'none';
		this._approveFile.label = state.approveFileLabel;
		this._approveFile.enabled = state.canApproveFile;

		this._fileLabel.textContent = state.fileLabel;
		this._fileLabel.dataset.widest = state.widestFileLabels.join('\n');
		this._previousFile.enabled = state.canNavigateFiles;
		this._nextFile.enabled = state.canNavigateFiles;
	}

	/**
	 * Places the bottom right corner of the bar. Only the size of the editor goes into that, and nothing
	 * that differs between files: not what the bar shows, and not how much room the line numbers take.
	 */
	layout(): void {
		const layoutInfo = this._editor.getLayoutInfo();
		const end = Math.min(layoutInfo.width / 2 + BAR_END_FROM_MIDDLE, layoutInfo.width - layoutInfo.verticalScrollbarWidth - BAR_MARGIN);

		this._position = {
			preference: {
				top: layoutInfo.height - layoutInfo.horizontalScrollbarHeight - BAR_MARGIN,
				left: Math.round(end)
			}
		};
		this._editor.layoutOverlayWidget(this);
	}
}
