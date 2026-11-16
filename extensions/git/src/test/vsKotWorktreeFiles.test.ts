/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getBranchSource, getGitErrorMessage, getNestedWorktreeFolders, isPythonEnvironment, parseWorktreeEntries, readWorktreeIncludeFile } from '../vsKotWorktreeFiles';

suite('vsKotWorktreeFiles', () => {

	test('what a worktree is given, and what is never copied into it', async () => {
		const root = path.join(path.sep, 'r', 'app');
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-kot-worktree-files-'));
		try {
			fs.mkdirSync(path.join(temp, 'venv'));
			fs.writeFileSync(path.join(temp, 'venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
			fs.mkdirSync(path.join(temp, 'plain'));

			assert.deepStrictEqual({
				includeFile: readWorktreeIncludeFile('# secrets\n.env\r\n\n  \n.env.*\n!.env.example\nconfig/*.local.json\n'),
				emptyIncludeFile: readWorktreeIncludeFile(''),
				nested: getNestedWorktreeFolders(root, [
					root,
					path.join(root, '.claude', 'worktrees', 'login'),
					path.join(root, 'trees', 'other'),
					path.join(root, '..dots', 'inside'),
					path.join(path.sep, 'r', 'app.worktrees', 'sibling'),
					path.join(path.sep, 'r', 'elsewhere'),
				]),
				pythonEnvironment: [await isPythonEnvironment(path.join(temp, 'venv')), await isPythonEnvironment(path.join(temp, 'plain')), await isPythonEnvironment(path.join(temp, 'missing'))],
			}, {
				includeFile: ['.env', '.env.*', '!.env.example', 'config/*.local.json'],
				emptyIncludeFile: [],
				nested: ['.claude/worktrees', '.claude/worktrees/login', 'trees/other', '..dots/inside'],
				pythonEnvironment: [true, false, false],
			});
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});

	test('the worktrees that git lists, and the messages of git', () => {
		const withZ = 'worktree /r/app\0HEAD 1111\0branch refs/heads/main\0\0worktree /r/app/.claude/worktrees/a b\0HEAD 2222\0detached\0locked claude agent\0\0worktree /r/gone\0HEAD 3333\0branch refs/heads/gone\0prunable gitdir file points to non-existent location\0\0';
		const withoutZ = 'worktree /r/app\nHEAD 1111\nbranch refs/heads/main\n\nworktree /r/other\nHEAD 2222\nlocked\n\n';

		assert.deepStrictEqual({
			withZ: parseWorktreeEntries(withZ),
			withoutZ: parseWorktreeEntries(withoutZ).map(worktree => [worktree.path, worktree.isLocked]),
			fatal: getGitErrorMessage('Preparing worktree (checking out \'x\')\nfatal: \'/r/x\' is a missing but already registered worktree;\nuse \'add -f\' to override, or \'prune\' or \'remove\' to clear\n'),
			none: getGitErrorMessage('git-lfs was not found on your path\n'),
			nothing: getGitErrorMessage(undefined),
		}, {
			withZ: [
				{ path: '/r/app', branch: 'refs/heads/main', isLocked: false, isPrunable: false },
				{ path: '/r/app/.claude/worktrees/a b', branch: undefined, isLocked: true, isPrunable: false },
				{ path: '/r/gone', branch: 'refs/heads/gone', isLocked: false, isPrunable: true },
			],
			withoutZ: [['/r/app', false], ['/r/other', true]],
			fatal: '\'/r/x\' is a missing but already registered worktree; use \'add -f\' to override, or \'prune\' or \'remove\' to clear',
			none: undefined,
			nothing: undefined,
		});
	});

	test('where the branch of a new worktree comes from', () => {
		const refs = ['refs/heads/main', 'refs/heads/Feature/login', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/teammate', 'refs/remotes/origin/shared', 'refs/remotes/fork/shared', 'refs/remotes/fork/only-fork', 'refs/remotes/a/twice', 'refs/remotes/b/twice', 'refs/remotes/my/fork/deep'];
		const remotes = ['origin', 'fork', 'a', 'b', 'my/fork'];
		const source = (name: string, defaultRemote?: string) => getBranchSource(name, refs, remotes, defaultRemote);

		assert.deepStrictEqual({
			local: source('Feature/login'),
			otherCase: source('Main'),
			otherCaseFolder: source('feature/x'),
			remote: source('teammate'),
			onlyOnFork: source('only-fork'),
			remoteWithSlash: source('deep'),
			severalPreferOrigin: source('shared'),
			severalPreferDefault: source('shared', 'fork'),
			severalNoneChosen: source('twice'),
			typedWithRemote: source('origin/teammate'),
			typedWithRemoteWithSlash: source('my/fork/deep'),
			new: source('fix/new'),
		}, {
			local: { kind: 'local' },
			otherCase: { kind: 'caseConflict', existing: 'main' },
			otherCaseFolder: { kind: 'caseConflict', existing: 'Feature/' },
			remote: { kind: 'remote', ref: 'refs/remotes/origin/teammate' },
			onlyOnFork: { kind: 'remote', ref: 'refs/remotes/fork/only-fork' },
			remoteWithSlash: { kind: 'remote', ref: 'refs/remotes/my/fork/deep' },
			severalPreferOrigin: { kind: 'remote', ref: 'refs/remotes/origin/shared' },
			severalPreferDefault: { kind: 'remote', ref: 'refs/remotes/fork/shared' },
			severalNoneChosen: { kind: 'ambiguous' },
			typedWithRemote: { kind: 'remoteName', branch: 'teammate' },
			typedWithRemoteWithSlash: { kind: 'remoteName', branch: 'deep' },
			new: { kind: 'new' },
		});
	});
});
