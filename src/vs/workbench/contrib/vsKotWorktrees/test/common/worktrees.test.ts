/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getWorktreeFolderName, getWorktreesState, isLockedByClaude, isTemporaryClaudeWorktree, isValidBranchName, parseWorktreeList } from '../../common/worktrees.js';

suite('Worktrees', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** What `git worktree list --porcelain -z` prints: a NUL after each line, and one more after each worktree. */
	const porcelain = (...worktrees: string[][]) => worktrees.map(lines => lines.map(line => `${line}\0`).join('') + '\0').join('');

	test('the worktrees that git lists, with or without -z', () => {
		const withZ = porcelain(
			['worktree /r/app', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main'],
			['worktree /r/app/.claude/worktrees/login', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/feature/login'],
			['worktree /r/app/.claude/worktrees/agent-a0123456789abcdef', 'HEAD 3333333333333333333333333333333333333333', 'detached', 'locked claude subagent 7 (pid 42 start 1)'],
			['worktree /r/app.worktrees/gone', 'HEAD 4444444444444444444444444444444444444444', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location'],
			['worktree /r/locked', 'HEAD 5555555555555555555555555555555555555555', 'detached', 'locked'],
		);
		const withoutZ = 'worktree /r/bare\nbare\n\nworktree /r/other\nHEAD 6666666666666666666666666666666666666666\nbranch refs/heads/x\n\n';
		const summary = (output: string) => parseWorktreeList(output).map(worktree => [worktree.name, worktree.branch ?? worktree.head?.slice(0, 1), worktree.isMain, worktree.isBare, worktree.lockReason, worktree.isPrunable]);

		assert.deepStrictEqual({
			withZ: summary(withZ),
			withoutZ: summary(withoutZ),
			nothing: summary(''),
		}, {
			withZ: [
				['app', 'main', true, false, undefined, false],
				['login', 'feature/login', false, false, undefined, false],
				['agent-a0123456789abcdef', '3', false, false, 'claude subagent 7 (pid 42 start 1)', false],
				['gone', 'gone', false, false, undefined, true],
				['locked', '5', false, false, '', false],
			],
			withoutZ: [
				['bare', undefined, true, true, undefined, false],
				['other', 'x', false, false, undefined, false],
			],
			nothing: [],
		});
	});

	test('the main checkout, the worktree the window shows and the others to go to', () => {
		const worktrees = parseWorktreeList(porcelain(
			['worktree /r/app', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main'],
			['worktree /r/app/.claude/worktrees/zeta', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/zeta'],
			['worktree /r/app/.claude/worktrees/agent-a0123456789abcdef', 'HEAD 3333333333333333333333333333333333333333', 'detached', 'locked claude subagent 7 (pid 42 start 1)'],
			['worktree /r/app.worktrees/gone', 'HEAD 4444444444444444444444444444444444444444', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location'],
			['worktree /r/alpha', 'HEAD 5555555555555555555555555555555555555555', 'detached'],
		));
		const isSamePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
		const summary = (list: typeof worktrees, top: string, gitDirectory?: string, missing: string[] = []) => {
			const state = getWorktreesState(list, { top, prefix: 'packages/app/', gitDirectory, missing }, isSamePath);
			return { main: state.main?.name, current: state.current?.name, others: state.others.map(worktree => worktree.name), prefix: state.prefix };
		};
		// a bare clone with the checkouts as worktrees, and a submodule, where git lists its git folder first
		const bare = parseWorktreeList('worktree /r/repo.git\nbare\n\nworktree /r/main\nHEAD 6666666666666666666666666666666666666666\nbranch refs/heads/main\n\nworktree /r/pay\nHEAD 7777777777777777777777777777777777777777\nbranch refs/heads/pay\n');
		const submodule = parseWorktreeList('worktree /super/.git/modules/sub\nHEAD 8888888888888888888888888888888888888888\nbranch refs/heads/main\n');

		assert.deepStrictEqual({
			inMain: summary(worktrees, '/r/app', '/r/app/.git'),
			inWorktree: summary(worktrees, '/R/App/.claude/worktrees/zeta', '/r/app/.git'),
			elsewhere: summary(worktrees, '/somewhere/else'),
			bare: summary(bare, '/r/main', '/r/repo.git'),
			submodule: summary(submodule, '/super/sub', '/super/.git/modules/sub'),
			// a locked worktree whose folder is gone: git does not call it prunable, and it is not offered
			missingLocked: summary(worktrees, '/r/app', '/r/app/.git', ['/r/app/.claude/worktrees/agent-a0123456789abcdef']),
			names: getWorktreesState(worktrees, { top: '/r/app', prefix: '', gitDirectory: undefined, missing: [] }, isSamePath).names,
			temporary: worktrees.map(worktree => isTemporaryClaudeWorktree(worktree)),
			lockedByClaude: worktrees.map(worktree => isLockedByClaude(worktree)),
		}, {
			inMain: { main: 'app', current: 'app', others: ['agent-a0123456789abcdef', 'alpha', 'zeta'], prefix: 'packages/app/' },
			inWorktree: { main: 'app', current: 'zeta', others: ['agent-a0123456789abcdef', 'alpha', 'zeta'], prefix: 'packages/app/' },
			elsewhere: { main: 'app', current: undefined, others: ['agent-a0123456789abcdef', 'alpha', 'zeta'], prefix: 'packages/app/' },
			bare: { main: undefined, current: 'main', others: ['main', 'pay'], prefix: 'packages/app/' },
			submodule: { main: undefined, current: undefined, others: [], prefix: 'packages/app/' },
			missingLocked: { main: 'app', current: 'app', others: ['alpha', 'zeta'], prefix: 'packages/app/' },
			names: ['app', 'zeta', 'agent-a0123456789abcdef', 'gone', 'alpha'],
			temporary: [false, false, true, false, false],
			lockedByClaude: [false, false, true, false, false],
		});
	});

	test('branch names and the folders of new worktrees', () => {
		const names = ['feature/login', 'fix-1', 'with space', '-dash', 'a..b', 'end.', 'end/', 'x.lock', 'a@{b', '@', 'a//b', 'a/.b', 'ümlaut', ''];
		const taken = ['feature-login', 'Feature-Login-2'];

		assert.deepStrictEqual({
			valid: names.filter(name => isValidBranchName(name)),
			folders: {
				new: getWorktreeFolderName('fix/typo', taken),
				taken: getWorktreeFolderName('feature/login', taken),
				takenAgain: getWorktreeFolderName('FEATURE/login', [...taken, 'FEATURE-login-3']),
				odd: getWorktreeFolderName('.hidden/über ß', []),
				long: getWorktreeFolderName('x'.repeat(80), ['x'.repeat(64)]).length,
				nothingLeft: getWorktreeFolderName('///', []),
			},
		}, {
			valid: ['feature/login', 'fix-1', 'ümlaut'],
			folders: {
				new: 'fix-typo',
				taken: 'feature-login-3',
				takenAgain: 'FEATURE-login-4',
				odd: 'hidden-ber',
				long: 64,
				nothingLeft: 'worktree',
			},
		});
	});
});
