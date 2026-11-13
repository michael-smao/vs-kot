/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: what counts as a change to review? The reviewer's own typing, an accepted tab completion and a saved file must not;
// what another program writes into the file must. Drives the source build of the audit worktree.
//
//   node .vs-kot/release-check/own-edits.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedModelServer, repo, scratch } from './isolated.ts';

const ws = path.join(scratch, 'own-edits');
const root = path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
const git = (...args) => cp.execFileSync('git', args, { cwd: ws, encoding: 'utf8' }).trim();

// --- a small repository: two clean files, one file with a change "from Claude"
fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
const A = `export interface Item {\n    name: string;\n    price: number;\n    qty: number;\n}\n\nexport function total(items: Item[]): number {\n    return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n\nexport function names(items: Item[]): string[] {\n    return items.map((item) => item.name);\n}\n`;
const B = `export function greet(name: string): string {\n    return "Hello " + name;\n}\n\nexport function bye(name: string): string {\n    return "Bye " + name;\n}\n`;
fs.writeFileSync(path.join(ws, 'src', 'a.ts'), A); fs.writeFileSync(path.join(ws, 'src', 'b.ts'), B); fs.writeFileSync(path.join(ws, 'src', 'c.ts'), B.replace(/greet/g, 'welcome'));
git('init', '-q', '.'); git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init');
fs.writeFileSync(path.join(ws, 'src', 'b.ts'), B.replace('"Hello " + name', '`Hello, ${name}!`'));

fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ 'changeReview.autoReveal': true, 'editor.inlineSuggest.enabled': true, ...(process.env.EXTRA ? JSON.parse(process.env.EXTRA) : {}) }));
setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 300000).unref();
const results = []; const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', ...getIsolatedModelServer() }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await page.waitForTimeout(9000);
		const open = async name => { await page.keyboard.press('Meta+p'); await page.waitForTimeout(500); await page.keyboard.type(name, { delay: 5 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); };
		const goTo = async (line, end = true) => { await page.keyboard.press('Meta+1'); await page.waitForTimeout(150); await page.keyboard.press('Control+g'); await page.waitForTimeout(500); await page.keyboard.type(String(line), { delay: 10 }); await page.keyboard.press('Enter'); await page.waitForTimeout(400); if (end) { await page.keyboard.press('End'); } };
		// what the review draws in the active editor
		const drawn = () => page.evaluate(() => { const g = document.querySelector('.editor-group-container.active'); const q = s => g ? g.querySelectorAll(s).length : -1; return { pills: q('.change-review-hunk-widget'), addedLines: q('.view-overlays .change-review-line-added'), removedBlocks: q('.change-review-removed-zone'), bar: (g?.querySelector('.change-review-bar-widget')?.textContent || '').trim().slice(0, 40), file: (g?.querySelector('.tab.active .label-name')?.textContent || '') }; });
		const none = d => d.pills === 0 && d.addedLines === 0 && d.removedBlocks === 0 && !d.bar;
		const show = d => `${d.file}: ${d.pills} pill(s), ${d.addedLines} green line(s), ${d.removedBlocks} red block(s)${d.bar ? ', bar "' + d.bar + '"' : ''}`;
		const settle = () => page.waitForTimeout(1600);

		// 1. typing in a clean file
		await open('a.ts');
		check('a clean file shows nothing to review', none(await drawn()), show(await drawn()));
		await goTo(9); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
		await page.keyboard.type('export const TAX_RATE = 0.19;', { delay: 15 }); await settle();
		let d = await drawn();
		check('typing is not shown as a change', none(d), show(d));

		// 2. accepting a tab completion
		await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
		await page.keyboard.type('export function cheapest(items: Item[]): Item | undefined {', { delay: 15 }); await page.keyboard.press('Enter');
		const t = Date.now(); let ghost = '';
		while (Date.now() - t < 15000) { ghost = await page.evaluate(() => [...document.querySelectorAll('[class*="ghost-text"]')].map(e => e.textContent).join('').trim()); if (ghost) { break; } await page.waitForTimeout(30); }
		if (ghost) { await page.keyboard.press('Tab'); }
		await settle(); d = await drawn();
		check('an accepted tab completion is not shown as a change', !!ghost && none(d), ghost ? `accepted "${ghost.replace(/\s+/g, ' ').slice(0, 50)}"; ${show(d)}` : 'no suggestion arrived (is tab completion set up?)');

		// 3. saving stages what was written
		await page.keyboard.press('Escape'); await page.keyboard.press('Meta+s'); await page.waitForTimeout(4500);
		d = await drawn();
		const onDisk = fs.readFileSync(path.join(ws, 'src', 'a.ts'), 'utf8');
		check('after saving, the own edits are staged in git and nothing is shown', none(d) && git('diff', '--cached', '--name-only').split('\n').includes('src/a.ts') && !git('diff', '--name-only').split('\n').includes('src/a.ts') && onDisk.includes('TAX_RATE'), `staged: ${git('diff', '--cached', '--name-only').replace(/\n/g, ', ') || 'nothing'}; unstaged: ${git('diff', '--name-only').replace(/\n/g, ', ') || 'nothing'}; ${show(d)}`);

		// 4. another program changes the same file
		fs.writeFileSync(path.join(ws, 'src', 'a.ts'), onDisk.replace('return items.map((item) => item.name);', 'return items.map((item) => item.name.trim());'));
		await page.waitForTimeout(4000); d = await drawn();
		check('a change written by another program is shown for review', d.pills === 1 && d.addedLines >= 1 && d.removedBlocks === 1, show(d));

		// 5. typing next to it, with new lines above it
		await goTo(1); await page.keyboard.press('Home'); await page.keyboard.type('// items and what they cost', { delay: 10 }); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
		await settle(); d = await drawn();
		check('typing above that change adds no further change', d.pills === 1 && d.addedLines === 1 && d.removedBlocks === 1, show(d));

		// 6. another tab and back, with the typing still unsaved
		await open('c.ts'); await open('a.ts'); await settle(); d = await drawn();
		check('after switching tabs and back the unsaved typing is still not a change', d.pills === 1 && d.addedLines === 1, show(d));

		// 7. undo of own typing, and undo/redo of the outside change
		await goTo(3); await page.keyboard.type(' // note', { delay: 10 }); await settle();
		await page.keyboard.press('Meta+y'); await settle(); d = await drawn();          // Cmd+Z on a German keyboard
		check('undoing own typing leaves the one change', d.pills === 1 && d.addedLines === 1, show(d));

		// 8. approving the outside change
		await page.keyboard.press('Meta+s'); await page.waitForTimeout(3500);
		await page.keyboard.press('F7'); await page.waitForTimeout(600);
		await page.keyboard.press('Meta+z'); await page.waitForTimeout(3500); d = await drawn();   // Cmd+Y
		const staged = git('show', ':src/a.ts');
		check('approving it stages it, together with what was written', staged.includes('item.name.trim()') && staged.includes('// items and what they cost') && git('diff', '--name-only').split('\n').filter(f => f === 'src/a.ts').length === 0, `unstaged: ${git('diff', '--name-only').replace(/\n/g, ', ') || 'nothing'}; now showing ${show(d)}`);

		// 9. a file with a change from before: typing in it does not add changes
		await open('b.ts'); await settle(); d = await drawn();
		const before = d;
		await goTo(6); await page.keyboard.type(' // typed here', { delay: 10 }); await settle(); d = await drawn();
		check('a file changed by another program shows that change, and typing elsewhere in it adds none', before.pills === 1 && d.pills === 1 && d.addedLines === before.addedLines, `before ${show(before)}; after typing ${show(d)}`);

		// 10. while writing, changes elsewhere do not pull the reviewer away
		fs.writeFileSync(path.join(ws, 'src', 'c.ts'), B.replace(/greet/g, 'welcome').replace('"Bye " + name', '"Goodbye " + name'));
		await page.keyboard.type(' more', { delay: 10 }); await page.waitForTimeout(4000); d = await drawn();
		check('a change in another file does not take the editor away from where the reviewer is writing', d.file === 'b.ts', `active tab: ${d.file}`);

		// 11. a new file written here, and a new file written by another program
		fs.writeFileSync(path.join(ws, 'src', 'mine.ts'), '');
		fs.writeFileSync(path.join(ws, 'src', 'theirs.ts'), 'export const fromOutside = 1;\n');
		await page.waitForTimeout(2500);
		await open('mine.ts'); await page.keyboard.press('Meta+1'); await page.keyboard.type('export const mine = 1;', { delay: 15 }); await page.keyboard.press('Meta+s'); await page.waitForTimeout(5000); d = await drawn();
		check('a new file written here needs no approval and is staged on save', none(d) && git('diff', '--cached', '--name-only').split('\n').includes('src/mine.ts'), `${show(d)}; staged: ${git('diff', '--cached', '--name-only').replace(/\n/g, ', ')}`);
		await open('theirs.ts'); await settle(); d = await drawn();
		check('a new file written by another program is shown for review as a whole', /New File/.test(d.bar) && d.addedLines >= 1, show(d));
	} catch (e) { check('the run finished', false, String(e && e.message || e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
