/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: what the reviewer writes and saves before git has started is their own, however late git starts. Git
// starts late in a window whose folder is not trusted yet: the git extension only runs once it is. Here git is
// switched off in the settings and switched on after a while, which starts it the same way. Drives the source build.
//
//   node .vs-kot/release-check/late-git.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedClaudeRecord, getIsolatedModelServer, repo, scratch } from './isolated.ts';

const ws = path.join(scratch, 'late-git');
const root = path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
const git = (...args) => cp.execFileSync('git', args, { cwd: ws, encoding: 'utf8' }).trim();

/** For how long git stays off after the file was saved. The review once forgot after 15 seconds how a file looked when it was opened. */
const GIT_STARTS_AFTER_MS = 22000;

// --- a small repository: a clean file to write in, and a file with a change "from Claude"
fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
const B = `export function greet(name: string): string {\n    return "Hello " + name;\n}\n\nexport function bye(name: string): string {\n    return "Bye " + name;\n}\n`;
fs.writeFileSync(path.join(ws, 'src', 'mine.ts'), B); fs.writeFileSync(path.join(ws, 'src', 'theirs.ts'), B.replace(/greet/g, 'welcome'));
git('init', '-q', '.'); git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init');
fs.writeFileSync(path.join(ws, 'src', 'theirs.ts'), B.replace(/greet/g, 'welcome').replace('"Hello " + name', '`Hello, ${name}!`'));

const settings = { ...getIsolatedClaudeRecord(), 'changeReview.autoReveal': false, 'tabCompletion.enabled': false };
const writeSettings = (isGitEnabled: boolean) => fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ ...settings, 'git.enabled': isGitEnabled }));
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
writeSettings(false);
setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 300000).unref();
const results = []; const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', ...getIsolatedModelServer() }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await page.waitForTimeout(9000);
		const open = async name => { await page.keyboard.press('Meta+p'); await page.waitForTimeout(500); await page.keyboard.type(name, { delay: 5 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); };
		const goTo = async line => { await page.keyboard.press('Meta+1'); await page.waitForTimeout(150); await page.keyboard.press('Control+g'); await page.waitForTimeout(500); await page.keyboard.type(String(line), { delay: 10 }); await page.keyboard.press('Enter'); await page.waitForTimeout(400); await page.keyboard.press('End'); };
		// what the review draws in the active editor
		const drawn = () => page.evaluate(() => { const g = document.querySelector('.editor-group-container.active'); const q = s => g ? g.querySelectorAll(s).length : -1; return { pills: q('.change-review-hunk-widget'), addedLines: q('.view-overlays .change-review-line-added'), removedBlocks: q('.change-review-removed-zone'), bar: (g?.querySelector('.change-review-bar-widget')?.textContent || '').trim().slice(0, 40), file: (g?.querySelector('.tab.active .label-name')?.textContent || '') }; });
		const none = d => d.pills === 0 && d.addedLines === 0 && d.removedBlocks === 0 && !d.bar;
		const show = d => `${d.file}: ${d.pills} pill(s), ${d.addedLines} green line(s), ${d.removedBlocks} red block(s)${d.bar ? ', bar "' + d.bar + '"' : ''}`;

		// 1. git is off: the reviewer writes in a clean file and saves it
		await open('mine.ts');
		await goTo(6); await page.keyboard.type(' // written before git started', { delay: 15 });
		await page.keyboard.press('Meta+s'); await page.waitForTimeout(2000);
		const onDisk = fs.readFileSync(path.join(ws, 'src', 'mine.ts'), 'utf8');
		check('the file is saved while git is off, and nothing is staged', onDisk.includes('// written before git started') && git('diff', '--cached', '--name-only') === '', `on disk: ${onDisk.includes('// written before git started')}; staged: ${git('diff', '--cached', '--name-only') || 'nothing'}`);

		// 2. git starts, long after the file was opened
		await page.waitForTimeout(GIT_STARTS_AFTER_MS);
		writeSettings(true);
		await page.waitForTimeout(12000);
		let d = await drawn();
		const staged = git('diff', '--cached', '--name-only').split('\n'); const unstaged = git('diff', '--name-only').split('\n');
		check('once git has started, what was written is not shown as a change', none(d) && d.file === 'mine.ts', show(d));
		check('and it is staged, like anything the reviewer writes and saves', staged.includes('src/mine.ts') && !unstaged.includes('src/mine.ts'), `staged: ${staged.join(', ') || 'nothing'}; unstaged: ${unstaged.join(', ') || 'nothing'}`);

		// 3. what another program wrote before is still shown
		await open('theirs.ts'); await page.waitForTimeout(2500); d = await drawn();
		check('a change that another program made is shown for review', d.pills === 1 && d.addedLines >= 1 && d.removedBlocks === 1, show(d));
	} catch (e) { check('the run finished', false, String(e && e.message || e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
