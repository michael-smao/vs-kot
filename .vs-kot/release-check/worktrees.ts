/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: does the worktree switcher list the worktrees of a repository, create one, go there and back, and give a
// worktree the files that git does not track, such as .env? Also to a worktree that Claude Code created, which the
// editor did not see being made. Drives the source build, with a profile of its own and without tab completion.
//
//   node .vs-kot/release-check/worktrees.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedClaudeRecord, repo, scratch } from './isolated.ts';

const base = path.join(scratch, 'worktrees');
const main = path.join(base, 'main-app'); const ud = path.join(base, 'ud');
const git = (cwd: string, ...args: string[]) => cp.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;

const login = path.join(main, '.claude', 'worktrees', 'feature-login');
const session = path.join(main, '.claude', 'worktrees', 'cc-session');

const teammate = path.join(main, '.claude', 'worktrees', 'teammate');
const origin = path.join(base, 'origin.git'); const other = path.join(base, 'other');
const commit = (cwd: string, message: string) => git(cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);

fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(path.join(main, 'src'), { recursive: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(main, 'src', 'app.ts'), 'export const app = 1;\n');
fs.writeFileSync(path.join(main, '.gitignore'), '.env\n.dev.vars\nCLAUDE.local.md\n*.local\n');
git(main, 'init', '-q', '-b', 'main', '.'); git(main, 'add', '.'); commit(main, 'init');
// a teammate pushed a branch that this clone knows only from the remote
git(base, 'init', '-q', '--bare', origin); git(main, 'remote', 'add', 'origin', origin); git(main, 'push', '-q', 'origin', 'main');
git(base, 'clone', '-q', origin, other); git(other, 'checkout', '-q', '-b', 'teammate');
fs.writeFileSync(path.join(other, 'theirs.txt'), 'from the teammate\n'); git(other, 'add', '.'); commit(other, 'teammate'); git(other, 'push', '-q', 'origin', 'teammate');
git(main, 'fetch', '-q', 'origin');
const teammateCommit = git(other, 'rev-parse', 'HEAD');
// what git does not track: three files the worktrees need, and one they don't
fs.writeFileSync(path.join(main, '.env'), 'SECRET=root\n');
fs.writeFileSync(path.join(main, '.dev.vars'), 'WRANGLER=1\n');
fs.writeFileSync(path.join(main, 'CLAUDE.local.md'), 'notes\n');
fs.writeFileSync(path.join(main, 'notes.local'), 'not for worktrees\n');
// a worktree as Claude Code creates one: in .claude/worktrees, which this repository's .gitignore does not cover
git(main, 'worktree', 'add', '-q', '-b', 'worktree-cc-session', session);
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
	...getIsolatedClaudeRecord(),
	'changeReview.autoReveal': false, 'tabCompletion.enabled': false, 'editor.minimap.enabled': false
}));

setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 300000).unref();
const results: boolean[] = []; const check = (name: string, ok: boolean, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', VS_KOT_TAB_COMPLETION_HOME: path.join(base, 'tab-completion'), VS_KOT_TAB_COMPLETION_PORT: '11678' }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, main, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(base, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	const errors: string[] = [];
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		page.on('console', m => { if (m.type() === 'error' && /worktree|Cannot read|is not a function/i.test(m.text())) { errors.push(m.text().slice(0, 200)); } });
		const loaded = async () => { await sleep(3000); await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await sleep(9000); };
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await sleep(9000);

		const statusText = () => page.evaluate(() => (document.getElementById('status.vsKotWorktrees')?.textContent || '').trim());
		const explorerNames = () => page.evaluate(() => [...document.querySelectorAll('.explorer-folders-view .monaco-list-row .label-name')].map(e => (e.textContent || '').trim()));
		const openSwitcher = async () => {
			await page.keyboard.press('Meta+Shift+p'); await sleep(600); await page.keyboard.type('Switch Worktree', { delay: 5 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(2500);
		};
		const pickerRows = () => page.evaluate(() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(e => (e.getAttribute('aria-label') || '').replace(/\s+/g, ' ')));
		const pick = async (text: string) => { await page.locator('.quick-input-list .monaco-list-row', { hasText: text }).first().click(); };

		// 1. what the window shows at first: the main checkout, which has one worktree
		check('the status bar counts the worktrees of the main checkout', /^\S*\s*1$/.test(await statusText()), `"${await statusText()}"`);

		// 2. the switcher lists the main checkout and the worktree, and offers to create one
		await openSwitcher();
		const rows = await pickerRows();
		check('the switcher lists the main checkout first, then the worktree, then Create Worktree', rows.length === 3 && /main-app/.test(rows[0]) && /cc-session/.test(rows[1]) && /Create Worktree/.test(rows[2]), JSON.stringify(rows));

		// 3. a branch name that matches no worktree, and Create Worktree, which takes the name over
		await page.keyboard.type('feature/login', { delay: 5 }); await sleep(800);
		await pick('Create Worktree'); await sleep(1500);
		const inputValue = await page.evaluate(() => (document.querySelector('.quick-input-box input') as HTMLInputElement | null)?.value || '');
		await page.keyboard.press('Enter');
		await loaded();
		const list = git(main, 'worktree', 'list', '--porcelain');
		check('Create Worktree takes the typed name and creates the worktree in .claude/worktrees on a new branch', inputValue === 'feature/login' && list.includes(`worktree ${fs.realpathSync(login)}`) && list.includes('branch refs/heads/feature/login'), `input "${inputValue}"; ${list.split('\n').filter(l => l.startsWith('worktree') || l.startsWith('branch')).join(', ')}`);
		check('the new worktree has .env, .dev.vars and CLAUDE.local.md, and not what it does not need', read(path.join(login, '.env')) === 'SECRET=root\n' && read(path.join(login, '.dev.vars')) === 'WRANGLER=1\n' && read(path.join(login, 'CLAUDE.local.md')) === 'notes\n' && read(path.join(login, 'notes.local')) === undefined,
			`.env ${JSON.stringify(read(path.join(login, '.env')))}, .dev.vars ${JSON.stringify(read(path.join(login, '.dev.vars')))}, CLAUDE.local.md ${JSON.stringify(read(path.join(login, 'CLAUDE.local.md')))}, notes.local ${JSON.stringify(read(path.join(login, 'notes.local')))}`);
		check('git ignores the folder of the worktrees in the main checkout from now on', git(main, 'status', '--porcelain') === '' && (read(path.join(main, '.git', 'info', 'exclude')) || '').includes('/.claude/worktrees/'), `status: "${git(main, 'status', '--porcelain')}"`);

		// 4. the window shows the new worktree
		fs.writeFileSync(path.join(login, 'only-here.txt'), 'x\n'); await sleep(2500);
		let names = await explorerNames();
		check('the window shows the new worktree: the Explorer lists its files, the status bar names it', names.includes('only-here.txt') && names.includes('.env') && /feature-login/.test(await statusText()) && /feature-login/.test(await page.title()), `explorer: ${names.join(', ')}; status "${await statusText()}"; title "${await page.title()}"`);

		// 5. to the worktree that Claude Code created: it is given .env first
		const hadEnv = fs.existsSync(path.join(session, '.env'));
		await openSwitcher(); await pick('cc-session');
		await loaded();
		names = await explorerNames();
		check('switching to a worktree that Claude Code created gives it .env and shows it', !hadEnv && read(path.join(session, '.env')) === 'SECRET=root\n' && /cc-session/.test(await page.title()) && !names.includes('only-here.txt'), `had .env before: ${hadEnv}; .env now ${JSON.stringify(read(path.join(session, '.env')))}; title "${await page.title()}"; explorer: ${names.join(', ')}`);

		// 6. back to the main checkout
		await openSwitcher(); await pick('main-app');
		await loaded();
		names = await explorerNames();
		check('back in the main checkout, the Explorer shows its files and not the worktrees', /main-app/.test(await page.title()) && names.includes('src') && !names.includes('only-here.txt') && !names.includes('worktrees'), `title "${await page.title()}"; explorer: ${names.join(', ')}`);
		check('the status bar counts both worktrees', /^\S*\s*2$/.test(await statusText()), `"${await statusText()}"`);

		// 7. a branch that only the remote has: the worktree checks it out, tracking the remote
		await openSwitcher(); await page.keyboard.type('teammate', { delay: 5 }); await sleep(800);
		await pick('Create Worktree'); await sleep(1500); await page.keyboard.press('Enter');
		await loaded();
		const head = fs.existsSync(teammate) ? git(teammate, 'rev-parse', 'HEAD') : '';
		const upstream = fs.existsSync(teammate) ? git(teammate, 'rev-parse', '--abbrev-ref', '@{upstream}') : '';
		check('a branch that only the remote has is checked out in the new worktree, tracking the remote', head === teammateCommit && upstream === 'origin/teammate' && /teammate/.test(await page.title()), `HEAD ${head.slice(0, 7)} (the teammate's is ${teammateCommit.slice(0, 7)}), upstream "${upstream}", title "${await page.title()}"`);

		check('no errors from the switcher in the console', errors.length === 0, errors.join(' | '));
	} finally {
		await app.close().catch(() => undefined);
	}
	console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
	process.exit(results.every(Boolean) ? 0 : 1);
})();
