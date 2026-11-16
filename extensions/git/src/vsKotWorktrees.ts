/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: what the worktree switcher of the workbench (contrib/vsKotWorktrees) asks git for. The commands are not in
// the command palette. Paths are file system paths.

import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { commands, Disposable, l10n, LogOutputChannel } from 'vscode';
import { Git, GitError } from './git';
import { Model } from './model';
import { Repository } from './repository';
import { pathEquals } from './util';
import { getBranchSource, getGitErrorMessage, parseWorktreeEntries } from './vsKotWorktreeFiles';

/** The worktrees of the repository that a folder belongs to. */
interface IWorktreeList {
	/** The top folder of the checkout that the folder is in. */
	readonly top: string;
	/** Where the folder is in that checkout: `''` at its top, `packages/app/` in a folder of it. */
	readonly prefix: string;
	/**
	 * The git folder of the repository, its real path. Git lists it as the main checkout where there is none, as in
	 * a submodule or a checkout that keeps its git folder elsewhere.
	 */
	readonly gitDirectory: string | undefined;
	/** The worktrees whose folder is gone, as git names them. */
	readonly missing: readonly string[];
	/** What `git worktree list --porcelain` prints, NUL-separated where git can. */
	readonly output: string;
}

interface ICreateWorktreeResult {
	readonly path?: string;
	/** How many files and folders that git does not track were copied. `undefined` when none could be. */
	readonly copied?: number;
	/** Why the worktree could not be created. */
	readonly error?: string;
	/** What went wrong after the worktree was created, for example in a hook of git. */
	readonly warning?: string;
}

export function registerVsKotWorktreeCommands(git: Git, model: Model, logger: LogOutputChannel): Disposable {
	const isPath = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value);

	/** Whether `worktreePath` is a worktree of the repository whose main checkout is `mainRoot`, other than that one. */
	const isWorktreeOf = async (openRoot: string, mainRoot: string, worktreePath: string): Promise<boolean> => {
		const list = await listWorktrees(git, openRoot);
		const paths = list ? parseWorktreeEntries(list.output).map(worktree => path.normalize(worktree.path)) : [];
		return paths.length > 1 && paths[0] === path.normalize(mainRoot) && paths.slice(1).includes(path.normalize(worktreePath));
	};

	/**
	 * The repository that the window has open: its path as git names it, which is the real path. The window may
	 * have opened it through a symbolic link.
	 */
	const findRepository = async (roots: readonly string[]): Promise<Repository | undefined> => {
		for (const root of roots) {
			const repository = model.getRepository(root);
			if (repository) {
				return repository;
			}
		}
		const realRoots = await Promise.all(roots.map(root => fsPromises.realpath(root).catch(() => root)));
		return model.repositories.find(repository => realRoots.some(root => pathEquals(repository.rootRealPath ?? repository.root, root)));
	};

	/** `undefined` when git has not opened the repository in this window, and so cannot provide anything. */
	const provideFiles = async (openRoot: string, mainRoot: string, worktreePath: string): Promise<number | undefined> => {
		const repository = await findRepository([openRoot, mainRoot]);
		if (!repository) {
			logger.warn(`[vs-kot][worktrees] No repository is open at '${openRoot}': nothing was provided to '${worktreePath}'.`);
			return undefined;
		}
		return await repository.provideWorktreeFiles(worktreePath, mainRoot);
	};

	return Disposable.from(
		commands.registerCommand('git.vsKotListWorktrees', async (folder: unknown): Promise<IWorktreeList | undefined> => {
			return isPath(folder) ? await listWorktrees(git, folder) : undefined;
		}),

		// Provides the files that git does not track, such as `.env`, to a worktree: see provideWorktreeFiles
		commands.registerCommand('git.vsKotProvideWorktreeFiles', async (openRoot: unknown, mainRoot: unknown, worktreePath: unknown): Promise<number | undefined> => {
			if (!isPath(openRoot) || !isPath(mainRoot) || !isPath(worktreePath) || !await isWorktreeOf(openRoot, mainRoot, worktreePath)) {
				return undefined;
			}
			return await provideFiles(openRoot, mainRoot, worktreePath);
		}),

		// Creates a worktree for a branch at the given path and provides the files that git does not track to it.
		// The branch is the one here, or one that a remote has, or a new one from what the window shows.
		commands.registerCommand('git.vsKotCreateWorktree', async (openRoot: unknown, mainRoot: unknown, branch: unknown, worktreePath: unknown): Promise<ICreateWorktreeResult> => {
			if (!isPath(openRoot) || !isPath(mainRoot) || !isPath(worktreePath) || typeof branch !== 'string') {
				return { error: l10n.t('The worktree could not be created.') };
			}

			let name: string;
			try {
				name = (await git.exec(mainRoot, ['check-ref-format', '--branch', branch])).stdout.trim();
			} catch {
				return { error: l10n.t('"{0}" is not a valid branch name.', branch) };
			}

			let refs: string[];
			let remotes: string[];
			let defaultRemote: string | undefined;
			try {
				const lines = (output: string) => output.split('\n').filter(line => line.length > 0);
				refs = lines((await git.exec(mainRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).stdout);
				remotes = lines((await git.exec(mainRoot, ['remote'])).stdout);
				defaultRemote = await git.exec(mainRoot, ['config', '--get', 'checkout.defaultRemote']).then(result => result.stdout.trim() || undefined, () => undefined);
			} catch (err) {
				logger.warn(`[vs-kot][worktrees] Could not list the branches of '${mainRoot}': ${err}`);
				return { error: l10n.t('The worktree could not be created.') };
			}
			const source = getBranchSource(name, refs, remotes, defaultRemote);
			switch (source.kind) {
				case 'caseConflict':
					return { error: l10n.t('There is a branch {0} already. Branch names that differ only in capital letters are one branch on this computer.', source.existing) };
				case 'ambiguous':
					return { error: l10n.t('Several remotes have a branch {0}. Create a local branch for one of them first, or set checkout.defaultRemote.', name) };
				case 'remoteName':
					return { error: l10n.t('{0} is the branch of a remote. Enter its name without the remote: {1}.', name, source.branch) };
			}

			// A worktree whose folder is gone, and that has the branch, is not removed: its folder may have been moved
			const missing = await getMissingWorktreeOf(git, mainRoot, `refs/heads/${name}`);
			if (missing) {
				return { error: l10n.t('The branch {0} is checked out in a worktree whose folder is missing: {1}. When the folder was moved, run "git worktree repair" in it. When it was deleted, run "git worktree prune".', name, missing) };
			}

			try {
				await excludeWorktreeFolder(git, mainRoot, worktreePath);
			} catch (err) {
				logger.warn(`[vs-kot][worktrees] Could not make git ignore the folder of '${worktreePath}': ${err}`);
			}

			const args = source.kind === 'local' ? ['worktree', 'add', worktreePath, name]
				: source.kind === 'remote' ? ['worktree', 'add', '--track', '-b', name, worktreePath, source.ref]
					: ['worktree', 'add', '-b', name, worktreePath, 'HEAD'];
			let warning: string | undefined;
			try {
				await fsPromises.mkdir(path.dirname(worktreePath), { recursive: true });
				await git.exec(openRoot, args);
			} catch (err) {
				// A hook of git that fails, for example one of git-lfs, makes git fail after the worktree was created
				const list = await listWorktrees(git, mainRoot);
				const isCreated = !!list && parseWorktreeEntries(list.output).some(worktree => pathEquals(path.normalize(worktree.path), path.normalize(worktreePath)));
				const message = err instanceof GitError ? (getGitErrorMessage(err.stderr) ?? err.stderr?.trim()) : undefined;
				logger.warn(`[vs-kot][worktrees] git worktree add for '${worktreePath}' failed${isCreated ? ' after it created the worktree' : ''}: ${err}`);
				if (!isCreated) {
					return { error: message || l10n.t('The worktree could not be created.') };
				}
				warning = message;
			}

			return { path: worktreePath, copied: await provideFiles(openRoot, mainRoot, worktreePath), warning };
		})
	);
}

async function listWorktrees(git: Git, folder: string): Promise<IWorktreeList | undefined> {
	try {
		const [top, prefix, commonDir] = (await git.exec(folder, ['rev-parse', '--show-toplevel', '--show-prefix', '--git-common-dir'])).stdout.split('\n');
		let output: string;
		try {
			output = (await git.exec(folder, ['worktree', 'list', '--porcelain', '-z'])).stdout;
		} catch {
			output = (await git.exec(folder, ['worktree', 'list', '--porcelain'])).stdout; // git before 2.36 has no -z
		}
		const gitDirectory = await fsPromises.realpath(path.resolve(folder, commonDir)).catch(() => undefined);
		// Git does not call a locked worktree prunable when its folder is gone
		const paths = parseWorktreeEntries(output).map(worktree => worktree.path);
		const missing = (await Promise.all(paths.map(async worktreePath => await fsPromises.access(worktreePath).then(() => undefined, () => worktreePath)))).filter((worktreePath): worktreePath is string => worktreePath !== undefined);
		return { top: path.normalize(top), prefix, gitDirectory, missing, output };
	} catch {
		return undefined; // not in a git repository, or in a bare one
	}
}

/**
 * A worktree whose folder is gone stays registered with git until it is pruned or repaired, and git does not create
 * another one for its branch. The path of such a worktree that has the branch, so that the user can be told.
 */
async function getMissingWorktreeOf(git: Git, mainRoot: string, branchRef: string): Promise<string | undefined> {
	const list = await listWorktrees(git, mainRoot);
	const worktree = parseWorktreeEntries(list?.output ?? '').find(worktree => worktree.branch === branchRef && list?.missing.includes(worktree.path));
	return worktree?.path;
}

/**
 * A worktree inside the main checkout must be ignored there. Otherwise `git status` lists its folder, and a
 * `git add .` would add it as a repository of its own. When no `.gitignore` covers it, the folder that holds the
 * worktree is excluded for this clone only, in `.git/info/exclude`.
 */
async function excludeWorktreeFolder(git: Git, mainRoot: string, worktreePath: string): Promise<void> {
	const folder = path.relative(mainRoot, path.dirname(worktreePath));
	if (folder.length === 0 || folder === '..' || folder.startsWith(`..${path.sep}`) || path.isAbsolute(folder)) {
		return; // the worktree is not inside the main checkout
	}

	const pattern = folder.split(path.sep).join('/');
	try {
		await git.exec(mainRoot, ['check-ignore', '--quiet', `${pattern}/${path.basename(worktreePath)}/`]);
		return; // ignored already
	} catch (err) {
		if (!(err instanceof GitError) || err.exitCode !== 1) {
			throw err;
		}
	}

	const commonDir = path.resolve(mainRoot, (await git.exec(mainRoot, ['rev-parse', '--git-common-dir'])).stdout.trim());
	const excludeFile = path.join(commonDir, 'info', 'exclude');
	let content = '';
	try {
		content = await fsPromises.readFile(excludeFile, 'utf8');
	} catch {
		// there is no such file yet
	}
	await fsPromises.mkdir(path.dirname(excludeFile), { recursive: true });
	await fsPromises.appendFile(excludeFile, `${content.length > 0 && !content.endsWith('\n') ? '\n' : ''}/${pattern}/\n`, 'utf8');
}
