/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: what a worktree is given of the files that git does not track, such as `.env`. See provideWorktreeFiles in
// repository.ts. Nothing here imports vscode, so that the tests run without an editor.

import * as fsPromises from 'fs/promises';
import * as path from 'path';

/** Where Claude Code puts the worktrees it creates, relative to the main checkout. The editor puts its own there too. */
export const CLAUDE_WORKTREES_FOLDER = '.claude/worktrees';

/**
 * The patterns of a `.worktreeinclude` file, the file in which a project names for Claude Code what its worktrees
 * are given. The syntax is that of `.gitignore`: blank lines and comments are left out.
 */
export function readWorktreeIncludeFile(content: string): string[] {
	return content.split(/\r?\n/).filter(line => line.trim().length > 0 && !line.startsWith('#'));
}

/**
 * The folders of a main checkout that hold other worktrees, relative to it and with forward slashes: Claude Code's
 * folder of worktrees, and each worktree that lies inside the checkout. Nothing in them is copied into a worktree.
 */
export function getNestedWorktreeFolders(sourceRoot: string, worktreePaths: readonly string[]): string[] {
	const folders = new Set([CLAUDE_WORKTREES_FOLDER]);
	for (const worktreePath of worktreePaths) {
		const relative = path.relative(sourceRoot, worktreePath);
		if (relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
			folders.add(relative.split(path.sep).join('/'));
		}
	}
	return [...folders];
}

/**
 * Whether a folder is a Python environment. One is often called `.env`. Its scripts name the folder it was made in,
 * so a copy in a worktree would run the environment and the code of the main checkout: it is not copied.
 */
export async function isPythonEnvironment(folder: string): Promise<boolean> {
	try {
		return (await fsPromises.stat(path.join(folder, 'pyvenv.cfg'))).isFile();
	} catch {
		return false;
	}
}

/** A worktree in the output of `git worktree list --porcelain`. */
export interface IWorktreeEntry {
	readonly path: string;
	/** The branch that is checked out, with `refs/heads/`. */
	readonly branch: string | undefined;
	readonly isLocked: boolean;
	/** The folder of the worktree is gone. */
	readonly isPrunable: boolean;
}

/**
 * The worktrees in the output of `git worktree list --porcelain`, with or without `-z`. The first one is the main
 * checkout.
 */
export function parseWorktreeEntries(output: string): IWorktreeEntry[] {
	const entries: { path: string; branch: string | undefined; isLocked: boolean; isPrunable: boolean }[] = [];
	for (const line of output.split(output.includes('\0') ? '\0' : '\n')) {
		const entry = entries[entries.length - 1];
		if (line.startsWith('worktree ')) {
			entries.push({ path: line.slice('worktree '.length), branch: undefined, isLocked: false, isPrunable: false });
		} else if (entry && line.startsWith('branch ')) {
			entry.branch = line.slice('branch '.length);
		} else if (entry && (line === 'locked' || line.startsWith('locked '))) {
			entry.isLocked = true;
		} else if (entry && (line === 'prunable' || line.startsWith('prunable '))) {
			entry.isPrunable = true;
		}
	}
	return entries;
}

/** The message of a failed git command, as git wrote it from its `fatal:` or `error:` on, without that word. */
export function getGitErrorMessage(stderr: string | undefined): string | undefined {
	const lines = stderr?.split(/\r?\n/) ?? [];
	const start = lines.findIndex(line => /^(fatal|error): /.test(line));
	if (start === -1) {
		return undefined;
	}
	return lines.slice(start).map(line => line.replace(/^(fatal|error|hint): /, '').trim()).filter(line => line.length > 0).join(' ');
}

/**
 * How a worktree for a branch is created, from the branches that git has (`refs/heads/…` and `refs/remotes/…`):
 * - `local`: the branch exists here and is checked out
 * - `remote`: a remote has the branch, and a branch of that name that tracks it, `ref`, is created
 * - `new`: no one has the branch, and it is created from what the window shows
 * - `caseConflict`: a branch, or a folder of branches such as `Feature/`, has this name with other capital letters.
 *   Git keeps branches in files, and the file system of a Mac does not tell such names apart: both would be one
 *   branch, checked out twice, or a branch that git loses track of once it packs its branches.
 * - `remoteName`: the name is that of a branch of a remote, with the remote in front: `branch` is the name to take
 * - `ambiguous`: several remotes have the branch, and none of them is the one to take
 * @param remotes the names of the remotes, which may hold a `/` themselves
 * @param defaultRemote the remote that git takes when several have the branch, `checkout.defaultRemote`
 */
export function getBranchSource(name: string, refs: readonly string[], remotes: readonly string[], defaultRemote: string | undefined): { readonly kind: 'local' | 'new' | 'ambiguous' } | { readonly kind: 'remote'; readonly ref: string } | { readonly kind: 'caseConflict'; readonly existing: string } | { readonly kind: 'remoteName'; readonly branch: string } {
	const local = `refs/heads/${name}`;
	if (refs.includes(local)) {
		return { kind: 'local' };
	}

	// The branch itself, and each folder it is in, against what git has with other capital letters
	const heads = refs.filter(ref => ref.startsWith('refs/heads/'));
	const parts = local.split('/');
	for (let length = parts.length; length > 2; length--) {
		const prefix = parts.slice(0, length).join('/');
		const isBranch = length === parts.length;
		const conflict = heads.find(ref => {
			const other = ref.split('/').slice(0, length).join('/');
			const isOtherBranch = ref.split('/').length === length;
			return other !== prefix && other.toLowerCase() === prefix.toLowerCase() && (isBranch ? isOtherBranch : !isOtherBranch);
		});
		if (conflict) {
			const existing = conflict.split('/').slice(2, length).join('/');
			return { kind: 'caseConflict', existing: isBranch ? existing : `${existing}/` };
		}
	}

	// A remote is the first part of the name of its branches, the longest that fits
	const sortedRemotes = [...remotes].sort((a, b) => b.length - a.length);
	const remoteOf = (ref: string) => sortedRemotes.find(remote => ref.startsWith(`refs/remotes/${remote}/`));
	const tracking = refs.filter(ref => {
		const remote = remoteOf(ref);
		return remote !== undefined && ref.slice(`refs/remotes/${remote}/`.length) === name;
	});
	const chosen = tracking.length === 1 ? tracking[0] : tracking.find(ref => remoteOf(ref) === (defaultRemote ?? 'origin'));
	if (chosen) {
		return { kind: 'remote', ref: chosen };
	}
	if (tracking.length > 1) {
		return { kind: 'ambiguous' };
	}
	const remote = remoteOf(`refs/remotes/${name}`);
	if (remote !== undefined && refs.includes(`refs/remotes/${name}`)) {
		return { kind: 'remoteName', branch: name.slice(remote.length + 1) };
	}
	return { kind: 'new' };
}
