/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/changeReview.css';

import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { raceTimeout, RunOnceScheduler, Sequencer } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { hash } from '../../../../base/common/hash.js';
import { Disposable, DisposableStore, IReference, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { EmbeddedCodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/embeddedCodeEditorWidget.js';
import { LineSource, renderLines, RenderOptions } from '../../../../editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { DetailedLineRangeMapping, LineRangeMapping } from '../../../../editor/common/diff/rangeMapping.js';
import { IEditorContribution, IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelDeltaDecoration, ITextModel } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { IEditorWorkerService } from '../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { InlineDecoration, InlineDecorationType } from '../../../../editor/common/viewModel/inlineDecorations.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { diffInserted, diffInsertedLine, diffRemoved, diffRemovedLine, registerColor } from '../../../../platform/theme/common/colorRegistry.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IQuickDiffModelService, QuickDiffModel } from '../../scm/browser/quickDiffModel.js';
import { CHANGE_REVIEW_EDITOR_CONTRIBUTION_ID, ChangeReviewCommandId, ChangeReviewFileKind, ctxChangeReviewCursorInChange, ctxChangeReviewHasChanges, ctxChangeReviewHasPendingChanges, IChangeReviewEditor, IChangeReviewService } from '../common/changeReview.js';

// --- colors: brighter than the diff editor's, since here they sit inside the code that is being read

registerColor('changeReview.addedLineBackground',
	{ dark: '#3ddc8440', light: '#2db66a40', hcDark: diffInsertedLine, hcLight: diffInsertedLine },
	localize('changeReview.addedLineBackground', "Background color of lines that an unreviewed change added."));
registerColor('changeReview.addedTextBackground',
	{ dark: '#3ddc8470', light: '#2db66a70', hcDark: diffInserted, hcLight: diffInserted },
	localize('changeReview.addedTextBackground', "Background color of the text that an unreviewed change added inside a line."));
registerColor('changeReview.removedLineBackground',
	{ dark: '#ff5a5a47', light: '#f0484840', hcDark: diffRemovedLine, hcLight: diffRemovedLine },
	localize('changeReview.removedLineBackground', "Background color of lines that an unreviewed change removed."));
registerColor('changeReview.removedTextBackground',
	{ dark: '#ff5a5a80', light: '#f0484870', hcDark: diffRemoved, hcLight: diffRemoved },
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

interface IReviewHunk {
	/** Identifies the change by its content, so a flag survives line shifts but not a rewrite. */
	readonly key: string;
	/** What is reviewed as a whole, or `undefined` for a single change inside a modified file. */
	readonly wholeFile: ChangeReviewFileKind.Added | ChangeReviewFileKind.Deleted | undefined;
	/** Which lines of the reviewed version became which lines of the file. */
	readonly mapping: LineRangeMapping | undefined;
	/** The first editor line of the change. For removed lines: the line that follows them. */
	readonly startLineNumber: number;
	/** The last editor line of the change. */
	readonly endLineNumber: number;
	/** Whether the reviewer asked for this change to be redone. */
	readonly flagged: boolean;
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
	private readonly _quickDiffModel = this._register(new MutableDisposable<IReference<QuickDiffModel>>());
	private readonly _widgetStore = this._register(new DisposableStore());
	private readonly _bar = this._register(new MutableDisposable<ChangeReviewBarWidget>());
	private readonly _decorations: IEditorDecorationsCollection;
	private _viewZoneIds: string[] = [];
	private _widgets: ChangeReviewHunkWidget[] = [];

	private _hunks: IReviewHunk[] = [];

	/** The staged version of the file as git serves it. It follows a change of the index with some delay. */
	private _index: ITextModel | undefined;
	private readonly _indexListener = this._register(new MutableDisposable());
	/**
	 * The reviewed version of the file: what the changes are computed against. It is the staged version, plus
	 * what was approved here a moment ago and is still on its way into git. That makes approving instant, and
	 * a second approval never builds on a staged version that does not have the first one yet.
	 */
	private readonly _baseline = this._register(new MutableDisposable<ITextModel>());
	private readonly _baselineListener = this._register(new MutableDisposable());
	/** What git was asked to stage. Until it serves that, its staged version is behind and is not taken over. */
	private _expectedIndex: string | undefined;
	/** If git never serves what it was asked to stage, staging failed: go back to what it does serve. */
	private readonly _giveUpExpectedIndex = this._register(new RunOnceScheduler(() => this._adoptIndex(), 8000));
	private readonly _stageSequencer = new Sequencer();

	private _mappings: readonly LineRangeMapping[] = [];
	/** The versions of the reviewed version and of the file that {@link _mappings} were computed for. */
	private _diffVersions: { readonly baseline: number; readonly model: number } | undefined;
	private _diffRequestId = 0;
	private readonly _diffScheduler = this._register(new RunOnceScheduler(() => this._computeDiff(), 100));
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
		@IQuickDiffModelService private readonly _quickDiffModelService: IQuickDiffModelService,
		@ITextFileService textFileService: ITextFileService,
		@IEditorService private readonly _editorService: IEditorService,
		@ICommandService private readonly _commandService: ICommandService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILabelService private readonly _labelService: ILabelService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@IEditorWorkerService private readonly _editorWorkerService: IEditorWorkerService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
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
		this._register(textFileService.files.onDidResolve(e => {
			// The diff against the staged version only exists for a loaded file
			const model = this._editor.getModel();
			if (model && !this._quickDiffModel.value && isEqual(e.model.resource, model.uri)) {
				this._acquireQuickDiffModel(model);
			}
		}));
		this._register(toDisposable(() => this._clearRendering()));

		this._onDidChangeModel();
	}

	// --- state

	private _onDidChangeModel(): void {
		this._modelStore.clear();
		this._quickDiffModel.clear();
		this._hunks = [];
		this._index = undefined;
		this._indexListener.clear();
		this._clearBaseline();
		this._isKnown = false;
		this._lastPendingCount = undefined;
		this._revealWhenKnown = false;
		this._clearRendering();
		this._ctxHasChanges.set(false);
		this._ctxHasPendingChanges.set(false);
		this._ctxCursorInChange.set(false);

		const model = this._editor.getModel();
		if (!model) {
			return;
		}

		this._modelStore.add(model.onDidChangeContent(() => this._diffScheduler.schedule()));
		this._serviceSignature = this._getServiceSignature(model);
		this._acquireQuickDiffModel(model);
		this._update();
	}

	private _acquireQuickDiffModel(model: ITextModel): void {
		if (model.uri.scheme !== Schemas.file && model.uri.scheme !== Schemas.vscodeRemote) {
			return;
		}

		const reference = this._quickDiffModelService.createQuickDiffModelReference(model.uri);
		if (!reference) {
			return;
		}

		this._quickDiffModel.value = reference;
		this._modelStore.add(reference.object.onDidChange(() => this._syncIndex()));
		this._syncIndex();
	}

	// --- the reviewed version of a modified file, and its changes

	/** Git says through the quick diff which resource holds the staged version of the file. */
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
		const model = this._editor.getModel();
		const index = this._index;
		if (!model || !index || index.isDisposed()) {
			// No staged version: the file is new, not in a repository, or not known yet
			if (this._baseline.value) {
				this._clearBaseline();
				this._update();
			}
			return;
		}

		const contents = index.getValue();
		if (this._expectedIndex !== undefined) {
			if (contents !== this._expectedIndex) {
				return; // git has not caught up with what was approved here
			}
			this._expectedIndex = undefined;
			this._giveUpExpectedIndex.cancel();
		}

		const baseline = this._baseline.value;
		if (!baseline) {
			const language = this._languageService.createById(model.getLanguageId());
			const created = this._modelService.createModel(contents, language, undefined, true);
			this._baseline.value = created;
			this._baselineListener.value = created.onDidChangeContent(() => this._computeDiff());
			this._computeDiff();
		} else if (baseline.getValue() !== contents) {
			baseline.setValue(contents);
		}
	}

	/** Takes the staged version as git serves it, whatever was expected of it. */
	private _adoptIndex(): void {
		this._expectedIndex = undefined;
		this._giveUpExpectedIndex.cancel();
		this._onDidChangeIndex();
	}

	private _clearBaseline(): void {
		this._baselineListener.clear();
		this._baseline.clear();
		this._expectedIndex = undefined;
		this._giveUpExpectedIndex.cancel();
		this._diffScheduler.cancel();
		this._diffRequestId++;
		this._mappings = [];
		this._diffVersions = undefined;
	}

	private async _computeDiff(): Promise<void> {
		const model = this._editor.getModel();
		const baseline = this._baseline.value;
		if (!model || !baseline) {
			return;
		}

		this._diffScheduler.cancel();
		const requestId = ++this._diffRequestId;
		const versions = { baseline: baseline.getVersionId(), model: model.getVersionId() };
		const result = await this._editorWorkerService.computeDiff(baseline.uri, model.uri, { ignoreTrimWhitespace: false, maxComputationTimeMs: 2000, computeMoves: false }, 'advanced');

		// Outdated when anything moved on in the meantime. Whatever moved on has asked for a new diff.
		if (requestId !== this._diffRequestId || this._baseline.value !== baseline || this._editor.getModel() !== model
			|| baseline.getVersionId() !== versions.baseline || model.getVersionId() !== versions.model) {
			return;
		}

		this._mappings = result?.changes ?? [];
		this._diffVersions = versions;
		this._update();
	}

	/**
	 * Approves changes of a modified file: they become part of the reviewed version right away,
	 * and git is asked to stage that version.
	 */
	private _stage(model: ITextModel, hunks: readonly IReviewHunk[]): boolean {
		const baseline = this._baseline.value;
		const mappings = hunks.map(hunk => hunk.mapping).filter(mapping => !!mapping);
		if (!baseline || mappings.length === 0 || this._diffVersions?.baseline !== baseline.getVersionId() || this._diffVersions.model !== model.getVersionId()) {
			return false; // what is shown is about to be replaced by a newer diff
		}

		const baselineLines = baseline.getLinesContent();
		const modelLines = model.getLinesContent();
		baseline.applyEdits(mappings.map(mapping => {
			const rangeMapping = mapping.toRangeMapping2(baselineLines, modelLines);
			return { range: rangeMapping.originalRange, text: model.getValueInRange(rangeMapping.modifiedRange) };
		}));

		const contents = baseline.getValue();
		this._expectedIndex = contents;
		this._giveUpExpectedIndex.schedule();
		this._stageSequencer.queue(() => this._commandService.executeCommand('git.stageContent', model.uri, contents)).catch(() => {
			if (this._editor.getModel() === model) {
				this._adoptIndex(); // it did not get staged: show the changes again
			}
		});

		return true;
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
			this._updateBar(); // it also shows how many files are left
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

		// A new or a deleted file is reviewed as a whole
		const file = this._service.getFile(model.uri);
		if (file && file.kind !== ChangeReviewFileKind.Modified) {
			this._setHunks(model, [{
				key: WHOLE_FILE_KEY,
				wholeFile: file.kind,
				mapping: undefined,
				startLineNumber: 1,
				endLineNumber: model.getLineCount(),
				flagged: this._service.hasRequest(file.uri, WHOLE_FILE_KEY)
			}], true);
			return;
		}

		// A modified file is reviewed change by change, against its reviewed version
		const baseline = this._baseline.value;
		if (!baseline) {
			this._setHunks(model, [], false);
			return;
		}
		if (this._diffVersions?.baseline !== baseline.getVersionId() || this._diffVersions.model !== model.getVersionId()) {
			return; // the diff for what the editor shows right now is on its way
		}

		const fileUri = this._getFileUri(model);
		const lineCount = model.getLineCount();
		const occurrences = new Map<string, number>();
		const hunks = this._mappings.map((mapping): IReviewHunk => {
			const originalText = mapping.original.mapToLineArray(lineNumber => baseline.getLineContent(lineNumber)).join('\n');
			const modifiedText = mapping.modified.mapToLineArray(lineNumber => model.getLineContent(lineNumber)).join('\n');
			const contentHash = hash([originalText, modifiedText]).toString(36);
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
				flagged: this._service.hasRequest(fileUri, key)
			};
		});

		this._setHunks(model, hunks, true);
	}

	private _setHunks(model: ITextModel, hunks: IReviewHunk[], isKnown: boolean): void {
		this._hunks = hunks;
		this._isKnown = isKnown;

		const pendingCount = hunks.filter(hunk => !hunk.flagged).length;
		this._ctxHasChanges.set(hunks.length > 0);
		this._ctxHasPendingChanges.set(pendingCount > 0);

		this._render(model);

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
			return;
		}

		// New changes showed up in a file that was done: jump to them, unless the reviewer is typing there
		const hasNewChanges = previousPendingCount === 0 && this._service.autoReveal
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
		return pending.find(hunk => hunk.startLineNumber > lineNumber) ?? pending[0];
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

	private _clearRendering(): void {
		this._widgetStore.clear();
		this._widgets = [];
		this._bar.clear();
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
			return;
		}

		this._widgetStore.clear();
		this._removedHeights = new Map();

		const original = this._baseline.value;
		const lineCount = model.getLineCount();
		const decorations: IModelDeltaDecoration[] = [];

		this._editor.changeViewZones(accessor => {
			for (const id of this._viewZoneIds) {
				accessor.removeZone(id);
			}
			this._viewZoneIds = [];

			const renderOptions = RenderOptions.fromEditor(this._editor);

			for (const hunk of this._hunks) {
				const mapping = hunk.mapping;

				if (hunk.wholeFile !== undefined) {
					decorations.push({
						range: new Range(1, 1, lineCount, model.getLineMaxColumn(lineCount)),
						options: hunk.wholeFile === ChangeReviewFileKind.Added ? addedLineDecoration : removedLineDecoration
					});
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
					original.tokenization.forceTokenization(mapping.original.endLineNumberExclusive - 1);
					const source = new LineSource(
						mapping.original.mapToLineArray(lineNumber => original.tokenization.getLineTokens(lineNumber)),
						[],
						original.mightContainNonBasicASCII(),
						original.mightContainRTL()
					);
					const inlineDecorations = innerChanges
						.filter(innerChange => !innerChange.originalRange.isEmpty())
						.map(innerChange => new InlineDecoration(
							innerChange.originalRange.delta(-(mapping.original.startLineNumber - 1)),
							REMOVED_TEXT_CLASS_NAME,
							InlineDecorationType.Regular
						));

					const domNode = $('.change-review-removed-zone.view-lines.monaco-mouse-cursor-text');
					const result = renderLines(source, renderOptions, inlineDecorations, domNode);
					this._removedHeights.set(hunk, result.heightInLines);

					this._viewZoneIds.push(accessor.addZone({
						afterLineNumber: Math.min(hunk.startLineNumber - 1, lineCount),
						heightInLines: result.heightInLines,
						domNode,
						ordinal: REMOVED_ZONE_ORDINAL
					}));
				}
			}
		});

		this._decorations.set(decorations);

		// A file that is reviewed as a whole has its buttons in the bar, a single change has them right below it
		this._widgets = this._hunks
			.filter(hunk => hunk.wholeFile === undefined)
			.map(hunk => this._widgetStore.add(new ChangeReviewHunkWidget(
				this._editor,
				hunk,
				this._removedHeights.get(hunk) ?? 0,
				hunk.flagged ? localize('changeRequested', "Change Requested") : undefined,
				this._getHunkButtons(hunk)
			)));

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

	private _updateBar(): void {
		const bar = this._bar.value;
		const model = this._editor.getModel();
		if (!bar || !model || this._hunks.length === 0) {
			return;
		}

		const pending = this._getPendingHunks();
		const wholeFile = this._hunks[0].wholeFile !== undefined ? this._hunks[0] : undefined;

		let changeLabel: string;
		if (wholeFile) {
			changeLabel = wholeFile.flagged ? localize('changeRequested', "Change Requested")
				: wholeFile.wholeFile === ChangeReviewFileKind.Added ? localize('newFile', "New File")
					: localize('deletedFile', "Deleted File");
		} else {
			const current = this._getCurrentHunk();
			const index = current ? pending.indexOf(current) : -1;
			changeLabel = index !== -1 ? localize('changeOf', "{0} of {1}", index + 1, pending.length)
				: pending.length === 1 ? localize('oneChange', "1 Change")
					: pending.length > 1 ? localize('changes', "{0} Changes", pending.length)
						: localize('allRequested', "All Requested");
		}

		const fileUri = this._getFileUri(model);
		const pendingFiles = this._service.pendingFiles;
		const fileIndex = pendingFiles.findIndex(file => isEqual(file.uri, fileUri));
		const fileLabel = fileIndex !== -1 ? localize('fileOf', "File {0} of {1}", fileIndex + 1, pendingFiles.length)
			: pendingFiles.length === 0 ? localize('noFilesLeft', "No Files Left")
				: pendingFiles.length === 1 ? localize('oneFileLeft', "1 File Left")
					: localize('filesLeft', "{0} Files Left", pendingFiles.length);

		bar.update({
			changeLabel,
			canNavigateChanges: !wholeFile && pending.length > 0,
			isWholeFile: !!wholeFile,
			isFlagged: !!wholeFile?.flagged,
			canApproveFile: !!wholeFile || pending.length > 0,
			approveFileLabel: this._withKeybindingHint(localize('approveFile', "Approve File"), wholeFile ? ChangeReviewCommandId.ApproveChange : ChangeReviewCommandId.ApproveFile),
			requestChangeLabel: this._withKeybindingHint(localize('requestChange', "Request Change"), ChangeReviewCommandId.RequestChange),
			fileLabel,
			canNavigateFiles: pendingFiles.some(file => !isEqual(file.uri, fileUri))
		});
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
			this._service.setPendingCount(this._getFileUri(model), 0);
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
		const next = pending.find(hunk => hunk.startLineNumber > lineNumber);
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

		const hunkCountBefore = this._hunks.length;
		if (this._stage(model, [hunk]) && await this._waitForFewerHunks(hunkCountBefore)) {
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
		if (this._stage(model, this._getPendingHunks()) && await this._waitForFewerHunks(hunkCountBefore) && this._editor.getModel() === model) {
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

		const lines = hunk.startLineNumber === hunk.endLineNumber
			? localize('describeLine', "line {0}", hunk.startLineNumber)
			: localize('describeLines', "lines {0}-{1}", hunk.startLineNumber, hunk.endLineNumber);

		const mapping = hunk.mapping;
		const original = this._baseline.value;
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
	private _width: number | undefined;

	constructor(
		private readonly _editor: ICodeEditor,
		readonly hunk: IReviewHunk,
		private readonly _removedHeightInLines: number,
		label: string | undefined,
		buttons: readonly IReviewButton[]
	) {
		super();

		this._domNode = $('.change-review-hunk-widget');
		this._domNode.classList.toggle('flagged', hunk.flagged);

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

		this._width ??= this._domNode.offsetWidth;
		const top = bottom - this._editor.getScrollTop();
		const left = layoutInfo.contentLeft + layoutInfo.contentWidth - layoutInfo.verticalScrollbarWidth - this._width - 12;

		this._domNode.style.visibility = top > -lineHeight && top < layoutInfo.height ? '' : 'hidden';
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
	readonly canNavigateChanges: boolean;
	/** A new or a deleted file: there are no single changes, the bar decides about the file. */
	readonly isWholeFile: boolean;
	readonly isFlagged: boolean;
	readonly canApproveFile: boolean;
	readonly approveFileLabel: string;
	readonly requestChangeLabel: string;
	readonly fileLabel: string;
	readonly canNavigateFiles: boolean;
}

/** Floats at the bottom of an editor that shows changes under review: steps through changes and files. */
class ChangeReviewBarWidget extends Disposable implements IOverlayWidget {

	private static _idPool = 0;
	private readonly _id = `change-review-bar-widget-${ChangeReviewBarWidget._idPool++}`;

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

		this._domNode = $('.change-review-bar-widget');
		const iconButton = (container: HTMLElement, icon: string, action: keyof IBarActions) => {
			const button = createButton(container, this._store, { label: `$(${icon})`, title: titles[action], primary: false, run: () => actions[action]() }, true);
			button.element.classList.add('change-review-icon-button');
			return button;
		};

		this._changeSection = append(this._domNode, $('.change-review-bar-section'));
		this._previousChange = iconButton(this._changeSection, 'arrow-up', 'previousChange');
		this._changeLabel = append(this._changeSection, $('span.change-review-label'));
		this._nextChange = iconButton(this._changeSection, 'arrow-down', 'nextChange');

		const decisionSection = append(this._domNode, $('.change-review-bar-section'));
		this._requestChange = createButton(decisionSection, this._store, { label: '', title: titles.requestChange, primary: false, run: () => actions.requestChange() });
		this._undoRequest = createButton(decisionSection, this._store, { label: localize('undoRequest', "Undo Request"), title: titles.undoRequest, primary: false, run: () => actions.undoRequest() });
		this._approveFile = createButton(decisionSection, this._store, { label: '', title: titles.approveFile, primary: true, run: () => actions.approveFile() });

		const fileSection = append(this._domNode, $('.change-review-bar-section'));
		this._previousFile = iconButton(fileSection, 'arrow-left', 'previousFile');
		this._fileLabel = append(fileSection, $('span.change-review-label'));
		this._nextFile = iconButton(fileSection, 'arrow-right', 'nextFile');

		this._editor.addOverlayWidget(this);
		this._register(toDisposable(() => this._editor.removeOverlayWidget(this)));
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
		this._changeLabel.textContent = state.changeLabel;
		this._previousChange.element.style.display = state.isWholeFile ? 'none' : '';
		this._nextChange.element.style.display = state.isWholeFile ? 'none' : '';
		this._previousChange.enabled = state.canNavigateChanges;
		this._nextChange.enabled = state.canNavigateChanges;
		this._changeSection.classList.toggle('flagged', state.isFlagged);

		this._requestChange.label = state.requestChangeLabel;
		this._requestChange.element.style.display = state.isWholeFile && !state.isFlagged ? '' : 'none';
		this._undoRequest.element.style.display = state.isWholeFile && state.isFlagged ? '' : 'none';
		this._approveFile.label = state.approveFileLabel;
		this._approveFile.enabled = state.canApproveFile;

		this._fileLabel.textContent = state.fileLabel;
		this._previousFile.enabled = state.canNavigateFiles;
		this._nextFile.enabled = state.canNavigateFiles;

		this.layout();
	}

	layout(): void {
		const layoutInfo = this._editor.getLayoutInfo();
		const width = this._domNode.offsetWidth;
		const height = this._domNode.offsetHeight;

		this._position = {
			preference: {
				top: layoutInfo.height - layoutInfo.horizontalScrollbarHeight - height - 16,
				left: layoutInfo.contentLeft + Math.max(0, (layoutInfo.contentWidth - layoutInfo.verticalScrollbarWidth - width) / 2)
			}
		};
		this._editor.layoutOverlayWidget(this);
	}
}
