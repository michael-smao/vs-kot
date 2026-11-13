/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileChangeType, IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ISCMRepository, ISCMResource, ISCMService } from '../../scm/common/scm.js';
import { CHANGE_REVIEW_AUTO_REVEAL_SETTING, CHANGE_REVIEW_EDITOR_CONTRIBUTION_ID, CHANGE_REVIEW_ENABLED_SETTING, ChangeReviewFileKind, IChangeReviewEditor, IChangeReviewFile, IChangeReviewRequest, IChangeReviewService } from '../common/changeReview.js';

/** The git resource groups that hold changes which are not staged yet. */
const UNSTAGED_GROUP_IDS = new Set(['workingTree', 'untracked']);

function toReviewFile(resource: ISCMResource): IChangeReviewFile | undefined {
	const original = resource.multiDiffEditorOriginalUri;
	const modified = resource.multiDiffEditorModifiedUri;

	if (modified) {
		if (modified.scheme !== resource.sourceUri.scheme) {
			return undefined; // not a plain file, for example a submodule
		}
		return { uri: modified, editorUri: modified, kind: original ? ChangeReviewFileKind.Modified : ChangeReviewFileKind.Added };
	}

	if (original) {
		return { uri: resource.sourceUri, editorUri: original, kind: ChangeReviewFileKind.Deleted };
	}

	return undefined;
}

/** How long nothing must have been typed or clicked before the reviewer is taken to changes that arrived. */
const IDLE_BEFORE_REVEAL_MS = 3000;

export class ChangeReviewService extends Disposable implements IChangeReviewService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _files: IChangeReviewFile[] = [];
	private _filesByEditorUri = new ResourceMap<IChangeReviewFile>();

	/**
	 * How many changes of a file are still open, as last reported by an editor.
	 * A file without an entry was not looked at yet and counts as pending.
	 */
	private readonly _pendingCounts = new ResourceMap<number>();
	private _requests: IChangeReviewRequest[] = [];
	/** The file that {@link navigateFile} is opening at the moment. */
	private _navigationTarget: IChangeReviewFile | undefined;

	/** Whether the reviewer wrote in the active editor since they went there. Then they are working in it, not waiting for changes. */
	private _isWritingInActiveEditor = false;
	/** Repositories whose files were never listed yet. What they list first is what was there before, not something new. */
	private readonly _unlistedRepositories = new Set<ISCMRepository>();
	private _isFirstListing = false;

	private readonly _repositoryListeners = this._register(new DisposableMap<ISCMRepository>());
	private readonly _updateFilesScheduler = this._register(new RunOnceScheduler(() => this._updateFiles(), 100));
	private readonly _autoRevealScheduler = this._register(new RunOnceScheduler(() => this._revealIfIdle(), 300));
	/** When a key or a mouse button was last pressed in the window. Someone who just did that is busy with something. */
	private _lastInput = 0;

	constructor(
		@ISCMService private readonly _scmService: ISCMService,
		@IEditorService private readonly _editorService: IEditorService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		this._register(this._scmService.onDidAddRepository(repository => this._onDidAddRepository(repository)));
		this._register(this._scmService.onDidRemoveRepository(repository => {
			this._repositoryListeners.deleteAndDispose(repository);
			this._updateFilesScheduler.schedule();
		}));
		for (const repository of this._scmService.repositories) {
			this._onDidAddRepository(repository);
		}

		this._register(this._editorService.onDidActiveEditorChange(() => this._isWritingInActiveEditor = false));
		const onInput = () => this._lastInput = Date.now();
		this._register(addDisposableListener(mainWindow.document, 'keydown', onInput, { capture: true, passive: true }));
		this._register(addDisposableListener(mainWindow.document, 'mousedown', onInput, { capture: true, passive: true }));

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CHANGE_REVIEW_ENABLED_SETTING) || e.affectsConfiguration(CHANGE_REVIEW_AUTO_REVEAL_SETTING)) {
				this._onDidChange.fire();
				this._autoRevealScheduler.schedule();
			}
		}));

		// A file that is written again has something new to look at, whatever was decided before.
		this._register(this._fileService.onDidFilesChange(e => {
			let affected = false;
			for (const file of this._files) {
				if (file.kind !== ChangeReviewFileKind.Deleted && e.contains(file.uri, FileChangeType.UPDATED, FileChangeType.ADDED)) {
					affected = true;
					if (this._pendingCounts.get(file.uri) === 0) {
						this._pendingCounts.delete(file.uri);
					}
				}
			}
			if (affected) {
				this._onDidChange.fire();
				this._autoRevealScheduler.schedule();
			}
		}));
	}

	get enabled(): boolean {
		return this._configurationService.getValue<boolean>(CHANGE_REVIEW_ENABLED_SETTING) !== false;
	}

	get autoReveal(): boolean {
		return this._configurationService.getValue<boolean>(CHANGE_REVIEW_AUTO_REVEAL_SETTING) !== false;
	}

	get files(): readonly IChangeReviewFile[] {
		return this._files;
	}

	get pendingFiles(): readonly IChangeReviewFile[] {
		return this._files.filter(file => this._pendingCounts.get(file.uri) !== 0);
	}

	get requests(): readonly IChangeReviewRequest[] {
		return this._requests;
	}

	getFile(editorUri: URI): IChangeReviewFile | undefined {
		return this._filesByEditorUri.get(editorUri);
	}

	// --- files

	private _onDidAddRepository(repository: ISCMRepository): void {
		if (repository.provider.providerId !== 'git') {
			return;
		}

		const store = new DisposableStore();
		const onDidChange = () => {
			if (this._unlistedRepositories.delete(repository)) {
				this._isFirstListing = true;
			}
			this._updateFilesScheduler.schedule();
		};
		this._unlistedRepositories.add(repository);
		store.add(repository.provider.onDidChangeResources(onDidChange));
		store.add(repository.provider.onDidChangeResourceGroups(onDidChange));
		store.add(toDisposable(() => this._unlistedRepositories.delete(repository)));
		this._repositoryListeners.set(repository, store);

		this._updateFilesScheduler.schedule();
	}

	private _updateFiles(): void {
		// What a repository lists when the window opens was there before. It is shown in the status bar and can
		// be gone to, but the reviewer is not taken away from the editor the window came back with.
		const isFirstListing = this._isFirstListing;
		this._isFirstListing = false;

		const files: IChangeReviewFile[] = [];
		const filesByEditorUri = new ResourceMap<IChangeReviewFile>();

		for (const repository of this._repositoryListeners.keys()) {
			for (const group of repository.provider.groups) {
				if (!UNSTAGED_GROUP_IDS.has(group.id)) {
					continue;
				}
				for (const resource of group.resources) {
					const file = toReviewFile(resource);
					if (file && !filesByEditorUri.has(file.editorUri)) {
						filesByEditorUri.set(file.editorUri, file);
						files.push(file);
					}
				}
			}
		}

		const newFiles = files.filter(file => this._filesByEditorUri.get(file.editorUri)?.kind !== file.kind);
		const hasNewFile = newFiles.length > 0;
		const isUnchanged = !hasNewFile && files.length === this._files.length;
		if (isUnchanged) {
			return;
		}

		// Forget what was known about files that have nothing unstaged anymore, or that are back with something new
		const remaining = new ResourceMap<IChangeReviewFile>();
		for (const file of files) {
			remaining.set(file.uri, file);
		}
		for (const uri of [...this._pendingCounts.keys()]) {
			if (!remaining.has(uri)) {
				this._pendingCounts.delete(uri);
			}
		}
		for (const file of newFiles) {
			this._pendingCounts.delete(file.uri);
		}
		this._requests = this._requests.filter(request => remaining.has(request.uri));

		this._files = files;
		this._filesByEditorUri = filesByEditorUri;

		this._onDidChange.fire();
		if (hasNewFile && !isFirstListing) {
			this._autoRevealScheduler.schedule();
		}
	}

	reportOwnEdit(uri: URI): void {
		const active = EditorResourceAccessor.getOriginalUri(this._editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (active && isEqual(active, uri)) {
			this._isWritingInActiveEditor = true;
		}
	}

	setPendingCount(uri: URI, count: number): void {
		if (this._pendingCounts.get(uri) === count) {
			return;
		}
		this._pendingCounts.set(uri, count);
		this._onDidChange.fire();
	}

	// --- requests

	hasRequest(uri: URI, key: string): boolean {
		return this._requests.some(request => request.key === key && isEqual(request.uri, uri));
	}

	addRequest(request: IChangeReviewRequest): void {
		this._requests = [...this._requests.filter(other => other.key !== request.key || !isEqual(other.uri, request.uri)), request];
		this._onDidChange.fire();
	}

	removeRequest(uri: URI, key: string): void {
		this._setRequests(this._requests.filter(request => request.key !== key || !isEqual(request.uri, uri)));
	}

	retainRequests(uri: URI, keys: ReadonlySet<string>): void {
		this._setRequests(this._requests.filter(request => !isEqual(request.uri, uri) || keys.has(request.key)));
	}

	private _setRequests(requests: IChangeReviewRequest[]): void {
		if (requests.length === this._requests.length) {
			return;
		}
		this._requests = requests;
		this._onDidChange.fire();
	}

	// --- navigation

	/**
	 * New changes arrived. Jump to them, unless the reviewer is in the middle of a file:
	 * one that still has changes to review, or one they are writing in.
	 */
	private _revealIfIdle(): void {
		if (!this.enabled || !this.autoReveal || this._isWritingInActiveEditor || this._editorService.activeEditor?.isDirty()) {
			return; // someone with unsaved work in front of them is in the middle of it
		}

		// Someone who pressed a key or clicked a moment ago is doing something, wherever that is: opening a file,
		// reading on, about to type. They are taken to the new changes once they have paused.
		const idleFor = Date.now() - this._lastInput;
		if (idleFor < IDLE_BEFORE_REVEAL_MS) {
			this._autoRevealScheduler.schedule(IDLE_BEFORE_REVEAL_MS - idleFor + 50);
			return;
		}

		const pending = this.pendingFiles;
		if (pending.length === 0) {
			return;
		}

		const active = EditorResourceAccessor.getOriginalUri(this._editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (active && pending.some(file => isEqual(file.editorUri, active))) {
			return;
		}

		// Whoever is typing somewhere else, in the terminal or in a search box, keeps the keyboard: the file is
		// opened, and their keystrokes do not end up in it
		const hasEditorFocus = this._editorService.activeTextEditorControl?.hasTextFocus() ?? false;
		this.revealNextFile(undefined, !hasEditorFocus);
	}

	async revealNextFile(after?: URI, preserveFocus = false): Promise<boolean> {
		const pending = this.pendingFiles.filter(file => !after || !isEqual(file.uri, after));
		if (pending.length === 0) {
			if (after) {
				const message = this._requests.length === 0
					? localize('allReviewed', "All changes are reviewed.")
					: this._requests.length === 1
						? localize('allReviewedWithRequest', "All changes are reviewed. 1 change request is open.")
						: localize('allReviewedWithRequests', "All changes are reviewed. {0} change requests are open.", this._requests.length);
				this._notificationService.status(message, { hideAfter: 5000 });
			}
			return false;
		}

		// Continue with the file that follows the one just finished, and wrap around at the end
		let next = pending[0];
		if (after) {
			const index = this._files.findIndex(file => isEqual(file.uri, after));
			next = this._files.slice(index + 1).find(file => pending.includes(file)) ?? next;
		}

		await this._openFile(next, preserveFocus);
		return true;
	}

	async navigateFile(from: URI | undefined, previous: boolean): Promise<void> {
		const pending = this.pendingFiles;
		if (pending.length === 0) {
			return;
		}

		// Where the reviewer is, in the order of all files. A file that is done has no place among the pending ones.
		// While a file is still opening, that is where the reviewer is: a second step that comes before
		// the editor shows it goes on from there, and not once more from the file before.
		const origin = this._navigationTarget?.uri ?? from;
		const index = origin ? this._files.findIndex(file => isEqual(file.uri, origin)) : -1;
		let target: IChangeReviewFile | undefined;
		if (index === -1) {
			target = previous ? pending.at(-1) : pending[0];
		} else if (previous) {
			target = this._files.slice(0, index).findLast(file => pending.includes(file)) ?? pending.at(-1);
		} else {
			target = this._files.slice(index + 1).find(file => pending.includes(file)) ?? pending[0];
		}

		if (!target) {
			return;
		}

		this._navigationTarget = target;
		try {
			await this._openFile(target);
		} finally {
			if (this._navigationTarget === target) {
				this._navigationTarget = undefined;
			}
		}
	}

	private async _openFile(file: IChangeReviewFile, preserveFocus = false): Promise<void> {
		const pane = await this._editorService.openEditor({
			resource: file.editorUri,
			label: file.kind === ChangeReviewFileKind.Deleted ? localize('deletedFileLabel', "{0} (Deleted)", basename(file.uri)) : undefined,
			options: { revealIfOpened: true, preserveFocus }
		});

		const control = pane?.getControl();
		if (isCodeEditor(control) && isEqual(control.getModel()?.uri, file.editorUri)) {
			control.getContribution<IChangeReviewEditor>(CHANGE_REVIEW_EDITOR_CONTRIBUTION_ID)?.revealFirstPendingChange();
		} else if (pane && isEqual(EditorResourceAccessor.getOriginalUri(pane.input, { supportSideBySide: SideBySideEditor.PRIMARY }), file.editorUri)) {
			// Only when the file is what the editor shows now. When the reviewer went on to another file
			// before this one was open, there is nothing to offer.
			this._offerFileApproval(file);
		}
	}

	/** A file that has no text editor (an image, a binary) can only be approved as a whole. */
	private _offerFileApproval(file: IChangeReviewFile): void {
		this._notificationService.prompt(
			Severity.Info,
			localize('cannotShowInline', "The changes in {0} can't be shown as text. Approve the file as a whole?", basename(file.uri)),
			[{
				label: localize('approveFileChoice', "Approve File"),
				run: async () => {
					await this._commandService.executeCommand('git.stageFile', file.editorUri);
					await this.revealNextFile(file.uri);
				}
			}, {
				label: localize('skipFileChoice', "Skip"),
				run: async () => {
					this.setPendingCount(file.uri, 0);
					await this.revealNextFile(file.uri);
				}
			}]
		);
	}
}
