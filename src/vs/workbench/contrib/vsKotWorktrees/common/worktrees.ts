/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the worktree switcher. The window shows the main checkout of a repository or one of its git worktrees, and
// the switcher goes from one to another: it opens the folder of the other one in the window. A worktree is given the
// files that git does not track and that it needs, such as `.env`, before it is opened (see provideWorktreeFiles in
// extensions/git/src/repository.ts). New worktrees go where Claude Code puts its own, into `.claude/worktrees`.

import { Event } from '../../../../base/common/event.js';
import { Mutable } from '../../../../base/common/types.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** A worktree of a repository, as `git worktree list --porcelain` describes it. */
export interface IWorktree {
	/** The folder of the worktree, as git names it. */
	readonly path: string;
	/** The folder's name. */
	readonly name: string;
	/** The commit that is checked out. `undefined` in a bare repository. */
	readonly head: string | undefined;
	/** The branch that is checked out, without `refs/heads/`. `undefined` when no branch is checked out. */
	readonly branch: string | undefined;
	/** The main checkout, which git always lists first. */
	readonly isMain: boolean;
	/** A bare repository has no checkout to show. */
	readonly isBare: boolean;
	/** Why the worktree is locked: `''` when it is locked without a reason, `undefined` when it is not locked. */
	readonly lockReason: string | undefined;
	/** The folder of the worktree is gone. Git cleans such a worktree away on `git worktree prune`. */
	readonly isPrunable: boolean;
}

/** The worktrees of the repository that the window shows. */
export interface IWorktreesState {
	/** The top folder of the checkout that the window shows. */
	readonly top: string;
	/** Where the folder of the window is in that checkout: `''` at its top, `packages/app/` in a folder of it. */
	readonly prefix: string;
	/**
	 * The main checkout. `undefined` in a bare repository, and where git lists its own folder as the main checkout:
	 * in a submodule, or in a checkout that keeps its git folder elsewhere.
	 */
	readonly main: IWorktree | undefined;
	/** The worktree that the window shows. */
	readonly current: IWorktree | undefined;
	/** The worktrees other than the main checkout that can be gone to, sorted by name. */
	readonly others: readonly IWorktree[];
	/** The names of the folders of all worktrees that git lists, also of those whose folder is gone. */
	readonly names: readonly string[];
}

export const enum WorktreesCommandId {
	Switch = 'vsKot.worktrees.switch',
	Create = 'vsKot.worktrees.create',
}

/** The folder that the window shows is a checkout of a git repository whose worktrees are known. */
export const ctxWorktreesAvailable = new RawContextKey<boolean>('vsKotWorktreesAvailable', false);

export const IWorktreesService = createDecorator<IWorktreesService>('vsKotWorktreesService');

export interface IWorktreesService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;
	/** `undefined` while the folder that the window shows is not known to be a checkout of a git repository. */
	readonly state: IWorktreesState | undefined;

	/** Asks git again which worktrees there are. */
	refresh(): Promise<IWorktreesState | undefined>;
	/** Lists the main checkout and the worktrees to go to, and offers to create one. */
	pick(): Promise<void>;
	/** Asks for a branch, creates a worktree for it and goes there. */
	create(branch?: string): Promise<void>;
	/** Opens the worktree in this window, or in a new one. A worktree is given its files first. */
	switchTo(worktree: IWorktree, options?: { readonly newWindow?: boolean }): Promise<void>;
}

/** The worktrees in the output of `git worktree list --porcelain`, with or without `-z`. */
export function parseWorktreeList(output: string): IWorktree[] {
	const worktrees: IWorktree[] = [];
	let current: Mutable<IWorktree> | undefined;

	for (const line of output.split(output.includes('\0') ? '\0' : '\n')) {
		const { field, value } = /^(?<field>\S+)(?: (?<value>.*))?$/s.exec(line)?.groups ?? {};
		if (field === 'worktree' && value) {
			const name = value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? value;
			current = { path: value, name, head: undefined, branch: undefined, isMain: worktrees.length === 0, isBare: false, lockReason: undefined, isPrunable: false };
			worktrees.push(current);
		} else if (current) {
			switch (field) {
				case 'HEAD': current.head = value; break;
				case 'branch': current.branch = value?.replace(/^refs\/heads\//, ''); break;
				case 'bare': current.isBare = true; break;
				case 'locked': current.lockReason = value ?? ''; break;
				case 'prunable': current.isPrunable = true; break;
			}
		}
	}

	return worktrees;
}

/** Where the folder that the window shows is, as git tells it. */
export interface IWorktreesLocation {
	/** The top folder of the checkout. */
	readonly top: string;
	/** The folder in the checkout, `''` at its top. */
	readonly prefix: string;
	/** The git folder of the repository. */
	readonly gitDirectory: string | undefined;
	/** The worktrees whose folder is gone. Git does not call a locked one prunable. */
	readonly missing: readonly string[];
}

/**
 * The main checkout, the worktree that the window shows, and the other worktrees that can be gone to.
 * @param isSamePath tells whether two paths name the same folder
 */
export function getWorktreesState(worktrees: readonly IWorktree[], location: IWorktreesLocation, isSamePath: (a: string, b: string) => boolean): IWorktreesState {
	const { top, prefix, gitDirectory, missing } = location;
	const isCheckout = (worktree: IWorktree) => !worktree.isBare && !(gitDirectory !== undefined && isSamePath(worktree.path, gitDirectory));
	const isThere = (worktree: IWorktree) => !worktree.isPrunable && !missing.some(path => isSamePath(path, worktree.path));
	const main = worktrees.find(worktree => worktree.isMain && isCheckout(worktree));
	const current = worktrees.find(worktree => isCheckout(worktree) && isSamePath(worktree.path, top));
	const others = worktrees
		.filter(worktree => !worktree.isMain && isCheckout(worktree) && isThere(worktree))
		.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
	return { top, prefix, main, current, others, names: worktrees.map(worktree => worktree.name) };
}

/**
 * Claude Code makes worktrees of its own for a while, for tasks it runs on the side. They are listed after the others.
 * The names are those that Claude Code gives them.
 */
export function isTemporaryClaudeWorktree(worktree: IWorktree): boolean {
	return /^(agent-a[0-9a-f]{7,16}|wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+|wf-\d+|bridge-.+|(job|bg)-.+-[0-9a-f]{8})$/.test(worktree.name);
}

/** Claude Code locks a worktree while it works in it. */
export function isLockedByClaude(worktree: IWorktree): boolean {
	return worktree.lockReason?.startsWith('claude ') ?? false;
}

/**
 * Whether git could take the name for a branch. Git looks at the name itself again when it creates the branch; this
 * only finds what is plainly wrong, while the name is typed.
 */
export function isValidBranchName(name: string): boolean {
	return name.length > 0
		&& !/[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|\/\.|^[-./]|[./]$|\.lock$|^@$/.test(name);
}

/**
 * The name of the folder for a new worktree of a branch: the branch, with what is not a letter, a digit, `.`, `_`
 * or `-` turned into `-`, at most 64 characters long, as Claude Code names its worktrees. A number is added when
 * the name is taken, whatever the case of its letters: the file system of a Mac does not tell them apart.
 */
export function getWorktreeFolderName(branch: string, takenNames: Iterable<string>): string {
	const taken = new Set([...takenNames].map(name => name.toLowerCase()));
	const base = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '').slice(0, 64) || 'worktree';
	let name = base;
	for (let counter = 2; taken.has(name.toLowerCase()); counter++) {
		const suffix = `-${counter}`;
		name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
	}
	return name;
}
