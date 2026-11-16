/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the worktree switcher. See ../common/worktrees.ts for what it does.

import { Throttler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { dirname, joinPath, relativePath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputButton, IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IClaudeRecordService } from '../../changeReview/common/claudeRecord.js';
import { ISCMService } from '../../scm/common/scm.js';
import { ctxWorktreesAvailable, getWorktreeFolderName, getWorktreesState, isLockedByClaude, isTemporaryClaudeWorktree, isValidBranchName, IWorktree, IWorktreesService, IWorktreesState, parseWorktreeList } from '../common/worktrees.js';

/** Where Claude Code puts the worktrees it creates, relative to the main checkout. */
const CLAUDE_WORKTREES_FOLDER = ['.claude', 'worktrees'];

/** What the git extension answers, see extensions/git/src/vsKotWorktrees.ts. */
interface IWorktreeList {
	readonly top: string;
	readonly prefix: string;
	readonly gitDirectory: string | undefined;
	readonly missing: readonly string[];
	readonly output: string;
}
interface ICreateWorktreeResult {
	/** The folder of the new worktree. `undefined` when it could not be created. */
	readonly path?: string;
	/** How many files and folders that git does not track were copied into it. `undefined` when none could be. */
	readonly copied?: number;
	/** Why the worktree could not be created. */
	readonly error?: string;
	/** What went wrong after the worktree was created, for example in a hook of git. */
	readonly warning?: string;
}

interface IWorktreePickItem extends IQuickPickItem {
	readonly worktree?: IWorktree;
	readonly isCreate?: boolean;
}

export class WorktreesService extends Disposable implements IWorktreesService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _state: IWorktreesState | undefined;
	get state(): IWorktreesState | undefined {
		return this._state;
	}

	private readonly _refreshThrottler = this._register(new Throttler());
	private readonly _ctxAvailable: IContextKey<boolean>;
	private _isSwitching = false;

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IFileService private readonly _fileService: IFileService,
		@IHostService private readonly _hostService: IHostService,
		@ILabelService private readonly _labelService: ILabelService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IProgressService private readonly _progressService: IProgressService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@ISCMService scmService: ISCMService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IClaudeRecordService private readonly _claudeRecordService: IClaudeRecordService,
	) {
		super();

		this._ctxAvailable = ctxWorktreesAvailable.bindTo(contextKeyService);

		// Git answers once its extension has found the repository. Worktrees come and go while the window is in the
		// background too, for example when Claude Code creates one: they are looked at again when it comes back.
		this._register(scmService.onDidAddRepository(repository => {
			if (repository.provider.providerId === 'git') {
				this.refresh();
			}
		}));
		this._register(this._hostService.onDidChangeFocus(focused => {
			if (focused) {
				this.refresh();
			}
		}));
		this._register(this._workspaceContextService.onDidChangeWorkbenchState(() => this.refresh()));
		this.refresh();
	}

	// --- what there is

	/** The folder that the window shows. Worktrees are only switched in a window that shows one local folder. */
	private _getFolder(): URI | undefined {
		if (this._workspaceContextService.getWorkbenchState() !== WorkbenchState.FOLDER) {
			return undefined;
		}
		const folder = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return folder?.scheme === Schemas.file ? folder : undefined;
	}

	refresh(): Promise<IWorktreesState | undefined> {
		return this._refreshThrottler.queue(async () => {
			const state = await this._readState();
			if (this._store.isDisposed) {
				return state;
			}
			if (JSON.stringify(state) !== JSON.stringify(this._state)) {
				this._state = state;
				this._ctxAvailable.set(state !== undefined);
				this._registerWithClaudeRecord();
				this._onDidChange.fire();
			}
			return this._state;
		});
	}

	/** `undefined` unless the window shows a checkout of a git repository: the switcher goes from there. */
	private async _readState(): Promise<IWorktreesState | undefined> {
		const folder = this._getFolder();
		if (!folder) {
			return undefined;
		}

		let list: IWorktreeList | undefined;
		try {
			list = await this._commandService.executeCommand<IWorktreeList>('git.vsKotListWorktrees', folder.fsPath);
		} catch {
			list = undefined; // git is not there yet, or not at all
		}
		if (!list || typeof list.top !== 'string' || typeof list.output !== 'string') {
			return undefined;
		}

		const extUri = this._uriIdentityService.extUri;
		const location = { top: list.top, prefix: list.prefix ?? '', gitDirectory: list.gitDirectory, missing: list.missing ?? [] };
		const state = getWorktreesState(parseWorktreeList(list.output), location, (a, b) => extUri.isEqual(URI.file(a), URI.file(b)));
		return state.current ? state : undefined;
	}

	private _isSame(a: IWorktree | undefined, b: IWorktree | undefined): boolean {
		return !!a && !!b && this._uriIdentityService.extUri.isEqual(URI.file(a.path), URI.file(b.path));
	}

	/**
	 * What Claude Code stages or commits in a worktree is held under review, also while the window shows another
	 * checkout of the repository: then it is still held once the window goes to that worktree. The record notes the
	 * repositories once Claude Code is connected. The worktrees that Claude Code makes for a while for tasks on the
	 * side are left out: when it works in one of them, the script of the record finds it by itself, in the folder of
	 * worktrees of the main checkout. So the main checkout is noted too, also while the window shows a worktree.
	 */
	private _registerWithClaudeRecord(): void {
		if (this._state?.main) {
			this._claudeRecordService.registerRepository(URI.file(this._state.main.path));
		}
		for (const worktree of this._state?.others ?? []) {
			if (!isTemporaryClaudeWorktree(worktree)) {
				this._claudeRecordService.registerRepository(URI.file(worktree.path));
			}
		}
	}

	// --- picking

	async pick(): Promise<void> {
		const store = new DisposableStore();
		const picker = store.add(this._quickInputService.createQuickPick<IWorktreePickItem>({ useSeparators: true }));
		picker.title = localize('pickTitle', "Switch Worktree");
		picker.placeholder = localize('pickPlaceholder', "Select the checkout to show in this window");
		picker.matchOnDescription = true;
		picker.matchOnDetail = true;
		picker.busy = true;
		store.add(picker.onDidHide(() => store.dispose()));
		picker.show();

		const state = await this.refresh();
		if (store.isDisposed) {
			return;
		}
		if (!state?.current) {
			picker.hide();
			this._notificationService.info(localize('noCheckout', "The folder of this window is not a checkout of a git repository. Worktrees can only be switched from one."));
			return;
		}

		const newWindowButton: IQuickInputButton = {
			iconClass: ThemeIcon.asClassName(Codicon.emptyWindow),
			tooltip: localize('openInNewWindow', "Open in New Window"),
		};
		picker.items = this._getPickItems(state, newWindowButton);
		picker.title = localize('pickTitleOf', "Switch Worktree of {0}", (state.main ?? state.current).name);
		picker.activeItems = picker.items.filter((item): item is IWorktreePickItem => item.type !== 'separator' && this._isSame(item.worktree, state.current));
		picker.busy = false;

		store.add(picker.onDidTriggerItemButton(event => {
			if (event.item.worktree) {
				picker.hide();
				this.switchTo(event.item.worktree, { newWindow: true });
			}
		}));
		store.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			const typed = picker.value.trim();
			picker.hide();
			if (item?.isCreate) {
				this.create(typed.length > 0 && isValidBranchName(typed) ? typed : undefined);
			} else if (item?.worktree) {
				this.switchTo(item.worktree);
			}
		}));
	}

	private _getPickItems(state: IWorktreesState, newWindowButton: IQuickInputButton): (IWorktreePickItem | IQuickPickSeparator)[] {
		const items: (IWorktreePickItem | IQuickPickSeparator)[] = [];
		const toItem = (worktree: IWorktree): IWorktreePickItem => {
			let description = worktree.branch ?? (worktree.head
				? localize('detachedAt', "detached at {0}", worktree.head.slice(0, 7))
				: localize('detached', "detached"));
			if (isLockedByClaude(worktree)) {
				description = localize('inUseByClaude', "{0}, in use by Claude Code", description);
			}
			if (this._isSame(worktree, state.current)) {
				description = localize('shownHere', "{0}, shown in this window", description);
			}
			return {
				label: `$(${worktree.isMain ? Codicon.repo.id : Codicon.worktree.id}) ${worktree.name}`,
				description,
				detail: worktree.isMain ? localize('mainCheckout', "Main checkout") : this._getPathLabel(worktree, state),
				worktree,
				buttons: [newWindowButton],
			};
		};

		if (state.main) {
			items.push(toItem(state.main));
		}
		const own = state.others.filter(worktree => !isTemporaryClaudeWorktree(worktree));
		const temporary = state.others.filter(worktree => isTemporaryClaudeWorktree(worktree));
		if (own.length > 0) {
			items.push({ type: 'separator', label: localize('worktrees', "Worktrees") });
			items.push(...own.map(toItem));
		}
		if (temporary.length > 0) {
			items.push({ type: 'separator', label: localize('temporaryWorktrees', "Temporary Worktrees of Claude Code") });
			items.push(...temporary.map(toItem));
		}
		// A new worktree goes into the main checkout, and its files come from there
		if (state.main) {
			items.push({ type: 'separator' });
			items.push({ label: `$(${Codicon.add.id}) ${localize('createWorktree', "Create Worktree...")}`, isCreate: true, alwaysShow: true });
		}
		return items;
	}

	/** The folder of a worktree, relative to the main checkout when it lies inside it. */
	private _getPathLabel(worktree: IWorktree, state: IWorktreesState): string {
		const relative = state.main ? relativePath(URI.file(state.main.path), URI.file(worktree.path)) : undefined;
		return relative && !relative.startsWith('..') ? relative : this._labelService.getUriLabel(URI.file(worktree.path));
	}

	// --- creating

	async create(branch?: string): Promise<void> {
		const state = await this.refresh();
		if (!state) {
			this._notificationService.info(localize('noCheckoutCreate', "The folder of this window is not a checkout of a git repository. A worktree can only be created from one."));
			return;
		}
		const main = state.main;
		if (!main) {
			this._notificationService.info(localize('noMainCheckout', "The repository of this window has no main checkout, for example because it is a bare repository or a submodule. The switcher creates worktrees in the main checkout and gives them its files."));
			return;
		}

		const from = state.current?.branch ?? state.current?.head?.slice(0, 7) ?? 'HEAD';
		const name = await this._quickInputService.input({
			title: localize('createTitle', "Create Worktree"),
			prompt: localize('createPrompt', "A branch that exists, here or on a remote, is checked out in the new worktree. A new branch starts from {0}, which this window shows.", from),
			placeHolder: localize('createPlaceholder', "Name of the branch, for example feature/login"),
			value: branch,
			validateInput: async value => isValidBranchName(value.trim()) ? undefined : localize('invalidBranch', "Git does not take this as the name of a branch."),
		});
		const branchName = name?.trim();
		if (!branchName) {
			return;
		}

		// A branch can be checked out in one worktree only: the one that has it is gone to
		const existing = [main, ...state.others].find(worktree => worktree.branch === branchName);
		if (existing) {
			if (this._isSame(existing, state.current)) {
				this._notificationService.info(localize('branchShownHere', "This window shows the branch {0} already.", branchName));
			} else {
				await this.switchTo(existing);
			}
			return;
		}

		const folder = await this._getNewWorktreeFolder(URI.file(main.path), branchName, state);
		let result: ICreateWorktreeResult | undefined;
		try {
			result = await this._progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('creating', "Creating a worktree for {0}...", branchName),
			}, () => this._commandService.executeCommand<ICreateWorktreeResult>('git.vsKotCreateWorktree', state.top, main.path, branchName, folder.fsPath));
		} catch (error) {
			this._logService.error('[worktrees] could not create a worktree', error);
			result = { error: toErrorMessage(error) };
		}

		if (typeof result?.path !== 'string') {
			this._notificationService.error(localize('createFailed', "The worktree for {0} could not be created. {1}", branchName, result?.error ?? ''));
			return;
		}

		this._logService.info(`[worktrees] created ${result.path}, ${result.copied ?? 'nothing'} file(s) or folder(s) copied into it`);
		if (result.warning) {
			this._notificationService.warn(localize('createWarning', "The worktree for {0} was created, but git reported a problem: {1}", branchName, result.warning));
		}
		if (result.copied === undefined) {
			this._warnNothingProvided(result.path);
		}
		await this._open(result.path, await this._getFolderInWorktree(result.path, state), false, state);
	}

	/**
	 * A folder for a new worktree in `.claude/worktrees` of the main checkout, where Claude Code puts its own. It is
	 * not the folder of a worktree that git still has although its folder is gone: that may have been moved.
	 */
	private async _getNewWorktreeFolder(mainRoot: URI, branch: string, state: IWorktreesState): Promise<URI> {
		const parent = joinPath(mainRoot, ...CLAUDE_WORKTREES_FOLDER);
		const taken = new Set(state.names);
		try {
			const stat = await this._fileService.resolve(parent);
			for (const child of stat.children ?? []) {
				taken.add(child.name);
			}
		} catch {
			// there is no folder of worktrees yet
		}
		return joinPath(parent, getWorktreeFolderName(branch, taken));
	}

	// --- switching

	async switchTo(worktree: IWorktree, options?: { readonly newWindow?: boolean }): Promise<void> {
		const state = this._state;
		const newWindow = options?.newWindow ?? false;
		if (!state || this._isSwitching || (this._isSame(worktree, state.current) && !newWindow)) {
			return;
		}

		this._isSwitching = true;
		try {
			if (!worktree.isMain && state.main) {
				const main = state.main;
				let provided: number | undefined;
				try {
					provided = await this._progressService.withProgress({
						location: ProgressLocation.Notification,
						title: localize('providing', "Providing the files that git does not track to {0}...", worktree.name),
						delay: 500,
					}, () => this._commandService.executeCommand<number>('git.vsKotProvideWorktreeFiles', state.top, main.path, worktree.path));
				} catch (error) {
					this._logService.warn('[worktrees] could not provide the files to a worktree', error);
				}
				// The worktree is opened all the same: what it lacks can be copied by hand
				if (provided === undefined) {
					this._warnNothingProvided(worktree.path);
				}
			}

			await this._open(worktree.path, await this._getFolderInWorktree(worktree.path, state), newWindow, state);
		} finally {
			this._isSwitching = false;
		}
	}

	private _warnNothingProvided(worktreePath: string): void {
		this._notificationService.warn(localize('nothingProvided', "The files that git does not track, such as .env, could not be given to the worktree {0}: git has not opened the repository of this window. That happens when the window shows a folder inside the repository and git was not allowed to open the repository around it. Open the repository in the Source Control view, or copy the files from the main checkout by hand.", this._labelService.getUriLabel(URI.file(worktreePath))));
	}

	/** The window may show a folder of the checkout: the same folder of the other one is shown then, where it has it. */
	private async _getFolderInWorktree(worktreePath: string, state: IWorktreesState): Promise<URI> {
		const root = URI.file(worktreePath);
		const prefix = state.prefix.replace(/\/+$/, '');
		if (prefix.length > 0) {
			const target = joinPath(root, prefix);
			if (await this._fileService.exists(target)) {
				return target;
			}
		}
		return root;
	}

	/**
	 * Opens a folder of a checkout.
	 * @param root the top folder of that checkout
	 */
	private async _open(root: string, folder: URI, newWindow: boolean, state: IWorktreesState): Promise<void> {
		// A worktree is a checkout of the repository that the window shows. When the user trusts that checkout as a
		// whole, they trust the worktree too. Trust in only a folder of it is not taken further.
		if (this._workspaceTrustManagementService.isWorkspaceTrusted()) {
			try {
				const rootUri = URI.file(root);
				if (await this._isCheckoutTrusted(state) && !(await this._workspaceTrustManagementService.getUriTrustInfo(rootUri)).trusted) {
					await this._workspaceTrustManagementService.setUrisTrust([rootUri], true);
				}
			} catch (error) {
				this._logService.warn('[worktrees] could not trust a worktree', error);
			}
		}

		await this._hostService.openWindow([{ folderUri: folder }], newWindow ? { forceNewWindow: true } : { forceReuseWindow: true });
	}

	/**
	 * Whether the user trusts the checkout that the window shows as a whole. Git names its real folder, and trust is
	 * kept for the folder as the window opened it, which may be a symbolic link to it.
	 */
	private async _isCheckoutTrusted(state: IWorktreesState): Promise<boolean> {
		const top = URI.file(state.top);
		if ((await this._workspaceTrustManagementService.getUriTrustInfo(top)).trusted) {
			return true;
		}
		let windowRoot = this._getFolder();
		for (const segment of state.prefix.split('/')) {
			if (windowRoot && segment.length > 0) {
				windowRoot = dirname(windowRoot);
			}
		}
		if (!windowRoot || !(await this._workspaceTrustManagementService.getUriTrustInfo(windowRoot)).trusted) {
			return false;
		}
		const realRoot = await this._fileService.realpath(windowRoot);
		return !!realRoot && this._uriIdentityService.extUri.isEqual(realRoot, top);
	}
}
