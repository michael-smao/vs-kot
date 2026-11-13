/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: is what the change review draws stable, and does stepping through it always get somewhere? A file with many
// changes of every kind, rewritten rapidly from outside, typed in, approved in bursts, shown twice, and changed by
// a commit behind the editor's back. Drives the source build of the audit worktree.
//
//   node .vs-kot/release-check/review-stress.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedClaudeRecord, getIsolatedModelServer, repo, scratch } from './isolated.ts';

const ws = path.join(scratch, 'review-stress');
const root = path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
const git = (...args) => cp.execFileSync('git', args, { cwd: ws, encoding: 'utf8' }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- 900 numbered lines, and what "Claude" makes of them: 4 changed lines, 2 added, 3 removed, 350 removed, the last 2 removed
const line = n => `export const v${String(n).padStart(4, '0')} = ${n};`;
const original = Array.from({ length: 900 }, (_, i) => line(i + 1));
const changed = (extra = []) => {
	const lines = original.map((text, i) => [10, 30, 50, 70, ...extra].includes(i + 1) ? text.replace(' = ', ' = 1000 + ') : text);
	lines.splice(898, 2);                 // the last two lines
	lines.splice(299, 350);               // lines 300 to 649
	lines.splice(149, 3);                 // lines 150 to 152
	lines.splice(100, 0, '// added by another program', 'export const added = true;');
	return lines.join('\n') + '\n';
};
const HUNKS = 8;
const small = name => `export function ${name}(value: string): string {\n    return value;\n}\n\nexport function ${name}Twice(value: string): string {\n    return value + value;\n}\n`;

fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
const file = name => path.join(ws, 'src', name);
fs.writeFileSync(file('big.ts'), original.join('\n') + '\n'); fs.writeFileSync(file('two.ts'), small('two')); fs.writeFileSync(file('three.ts'), small('three')); fs.writeFileSync(file('four.ts'), small('four'));
git('init', '-q', '.'); git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init');
fs.writeFileSync(file('big.ts'), changed());
fs.writeFileSync(file('two.ts'), small('two').replace('return value;', 'return value.trim();'));
fs.chmodSync(file('three.ts'), 0o755);          // changed, but in no line

fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ ...getIsolatedClaudeRecord(), 'changeReview.autoReveal': false, 'tabCompletion.enabled': false, 'editor.minimap.enabled': false }));
setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 420000).unref();
const results = []; const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', ...getIsolatedModelServer() }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	const errors = [];
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		page.on('console', m => { if (m.type() === 'error' && /changeReview|ReviewedFile|view zone|Cannot read|is not a function/i.test(m.text())) { errors.push(m.text().slice(0, 160)); } });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await sleep(9000);
		const open = async name => { await page.keyboard.press('Meta+p'); await sleep(500); await page.keyboard.type(name, { delay: 5 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(2500); };
		const run = async name => { await page.keyboard.press('F1'); await sleep(500); await page.keyboard.type(name, { delay: 4 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(900); };
		const goTo = async n => { await page.keyboard.press('Meta+1'); await sleep(150); await page.keyboard.press('Control+g'); await sleep(500); await page.keyboard.type(String(n), { delay: 10 }); await page.keyboard.press('Enter'); await sleep(400); };
		// what the review knows and draws: the bar says how many changes there are, widgets and zones only exist near what is in view
		const drawn = () => page.evaluate(() => { const g = document.querySelector('.editor-group-container.active'); const q = s => g ? [...g.querySelectorAll(s)] : []; const bar = (g?.querySelector('.change-review-bar-widget')?.textContent || '').trim(); const m = /^(\d+) of (\d+)/.exec(bar); return { pills: q('.change-review-hunk-widget').length, zones: q('.change-review-removed-zone').length, at: m ? Number(m[1]) : 0, of: m ? Number(m[2]) : 0, bar: bar.slice(0, 34), file: g?.querySelector('.tab.active .label-name')?.textContent || '', line: Number((document.querySelector('.statusbar-item[id="status.editor.selection"]')?.textContent || '').replace(/Ln (\d+).*/, '$1')) }; });
		const all = () => page.evaluate(() => ({ pills: document.querySelectorAll('.change-review-hunk-widget').length, zones: document.querySelectorAll('.change-review-removed-zone').length, zoneNodes: document.querySelectorAll('.view-zones .change-review-removed-zone').length }));

		// 1. every change is there
		await open('big.ts'); await sleep(1500); let d = await drawn();
		check(`a file with ${HUNKS} changes of every kind shows ${HUNKS} changes`, d.pills === HUNKS && d.of === HUNKS && d.zones === 7, `${d.pills} widgets, ${d.zones} removed blocks, bar "${d.bar}"`);

		// 2. the large removed block is cut short
		const blocks = await page.evaluate(() => [...document.querySelectorAll('.change-review-removed-zone')].map(z => ({ lines: z.querySelectorAll('.view-line').length, more: z.querySelector('.change-review-removed-more')?.textContent || '' })));
		const largest = blocks.sort((a, b) => b.lines - a.lines)[0];
		check('350 removed lines are shown as 300 and a note about the rest', largest && largest.lines === 300 && /50 more removed lines/.test(largest.more), largest ? `${largest.lines} lines drawn, note "${largest.more}"` : 'no block');

		// 3. stepping through all of them forwards reaches each once, then leaves the file
		await goTo(1); const seen = [];
		for (let i = 0; i < HUNKS + 1; i++) { await page.keyboard.press('F7'); await sleep(700); d = await drawn(); seen.push(d.file === 'big.ts' ? d.at : d.file); }
		check('F7 visits every change in order and then goes on to the next file', JSON.stringify(seen.slice(0, HUNKS)) === JSON.stringify(Array.from({ length: HUNKS }, (_, i) => i + 1)) && typeof seen[HUNKS] === 'string' && seen[HUNKS] !== 'big.ts', seen.join(', '));

		// 4. and backwards
		await open('big.ts'); await goTo(250); const back = [];
		for (let i = 0; i < 3; i++) { await page.keyboard.press('Shift+F7'); await sleep(700); back.push((await drawn()).at); }
		check('Shift+F7 steps back through the changes', JSON.stringify(back) === JSON.stringify([7, 6, 5]) || JSON.stringify(back) === JSON.stringify([6, 5, 4]), back.join(', '));

		// 5. the file is rewritten many times in a row from outside
		for (let i = 0; i < 16; i++) { fs.writeFileSync(file('big.ts'), changed(i % 2 === 0 ? [20] : [20, 22, 24])); await sleep(140); }
		fs.writeFileSync(file('big.ts'), changed([20])); await sleep(4500); d = await drawn(); let a = await all();
		check('after 17 rapid rewrites from outside, exactly the changes of the last one are shown', d.of === HUNKS + 1 && a.pills === HUNKS + 1 && a.zones === 8 && a.zoneNodes === 8, `bar "${d.bar}", ${a.pills} widgets, ${a.zones} removed blocks`);

		// 6. typing next to changes rebuilds nothing
		await goTo(5); await page.keyboard.press('End');
		await page.evaluate(() => document.querySelectorAll('.change-review-hunk-widget, .change-review-removed-zone').forEach(e => e.setAttribute('data-kept', '1')));
		await page.keyboard.type(' // typed next to the changes', { delay: 30 }); await sleep(2500);
		const kept = await page.evaluate(() => ({ kept: document.querySelectorAll('[data-kept]').length, now: document.querySelectorAll('.change-review-hunk-widget, .change-review-removed-zone').length }));
		check('typing next to changes leaves their widgets and removed blocks untouched', kept.kept === kept.now && kept.now === (HUNKS + 1) + 8, `${kept.kept} of ${kept.now} elements are the ones from before`);
		await page.keyboard.press('Enter'); await page.keyboard.type('// a new line above them', { delay: 20 }); await sleep(2500); d = await drawn(); a = await all();
		check('a new line above them moves them along and adds none', d.of === HUNKS + 1 && a.pills === HUNKS + 1 && a.zones === 8, `bar "${d.bar}", ${a.pills} widgets`);

		// 7. approving in a burst: what is staged and what is left always add up
		await page.keyboard.press('Meta+s'); await sleep(3500);
		await goTo(1);
		for (let i = 0; i < 6; i++) { await page.keyboard.press('Meta+z'); await sleep(170); }     // Cmd+Y, six times in a second
		await sleep(6000); d = await drawn();
		const stagedHunks = (git('diff', '--cached', '-U0', '--', 'src/big.ts').match(/^@@/gm) || []).length;
		const unstagedHunks = (git('diff', '-U0', '--', 'src/big.ts').match(/^@@/gm) || []).length;
		check('a burst of approvals leaves git and the editor in agreement', stagedHunks >= 2 && d.of === unstagedHunks && d.file === 'big.ts', `${stagedHunks} hunks staged (own typing included), ${unstagedHunks} unstaged in git, editor shows ${d.of}`);

		// 8. the same file in two editor groups
		await run('View: Split Editor Right'); await sleep(2000); a = await all(); const perGroup = d.of;
		await page.keyboard.press('F7'); await sleep(500); await page.keyboard.press('Meta+z'); await sleep(4000);
		const groups = await page.evaluate(() => [...document.querySelectorAll('.editor-group-container')].map(g => { const m = /^(\d+) of (\d+)/.exec((g.querySelector('.change-review-bar-widget')?.textContent || '').trim()); return m ? Number(m[2]) : 0; }));
		check('shown in two groups, an approval in one shows in both', groups.length === 2 && groups[0] === perGroup - 1 && groups[1] === perGroup - 1, `before: ${perGroup} each; after approving one: ${groups.join(' and ')}`);
		await run('View: Close Editor Group'); await sleep(800);

		// 9. a commit behind the editor's back, and an approval right after it
		await open('two.ts'); await sleep(1200); d = await drawn();
		const before = d.of;
		fs.writeFileSync(file('two.ts'), small('two').replace('return value;', 'return value.trim();').replace('value + value', 'value.repeat(2)'));
		git('add', 'src/two.ts'); git('-c', 'user.name=claude', '-c', 'user.email=claude@example.com', 'commit', '-qm', 'committed by another program');
		await page.keyboard.press('Meta+1'); await page.keyboard.press('Meta+z'); await sleep(250); await page.keyboard.press('Meta+z'); await sleep(6000); d = await drawn();
		const indexIsHead = git('diff', '--cached', '--name-only').split('\n').filter(f => f === 'src/two.ts').length === 0;
		check('an approval right after another program committed does not undo that commit', before === 1 && indexIsHead && git('show', 'HEAD:src/two.ts').includes('value.repeat(2)') && git('show', ':src/two.ts').includes('value.repeat(2)'), `staged version ${indexIsHead ? 'equals' : 'DIFFERS FROM'} the commit; editor shows ${d.of} change(s)`);

		// 10. a file that changed in no line
		await open('three.ts'); await sleep(6500); d = await drawn();
		const hadBar = /No Lines to Show/.test(d.bar);
		await page.keyboard.press('Meta+1'); await page.keyboard.press('Meta+z'); await sleep(4000);
		check('a file whose mode changed is offered as a whole and can be approved', hadBar && !git('diff', '--name-only').split('\n').includes('src/three.ts') && /new mode 100755/.test(git('diff', '--cached', '--', 'src/three.ts')), `bar "${d.bar}"; unstaged now: ${git('diff', '--name-only').replace(/\n/g, ', ') || 'nothing'}`);

		// 11. a larger font
		await open('big.ts'); await sleep(1200); const z0 = await page.evaluate(() => document.querySelector('.change-review-removed-zone .view-line')?.getBoundingClientRect().height || 0);
		await run('Increase Editor Font Size'); await run('Increase Editor Font Size'); await run('Increase Editor Font Size'); await sleep(1500);
		const z1 = await page.evaluate(() => ({ removed: document.querySelector('.change-review-removed-zone .view-line')?.getBoundingClientRect().height || 0, normal: document.querySelector('.view-lines:not(.change-review-removed-zone) > .view-line')?.getBoundingClientRect().height || 0 }));
		check('with a larger editor font the removed lines are as tall as the others', z1.removed > z0 && Math.abs(z1.removed - z1.normal) < 1, `removed lines ${z0}px before, ${z1.removed}px after; other lines ${z1.normal}px`);
		await run('Reset Editor Font Size');

		// 12. approving everything leaves nothing behind
		await page.keyboard.press('Meta+1'); await page.keyboard.press('Meta+Shift+z'); await sleep(5000);         // Shift+Cmd+Y: approve the file
		a = await all();
		check('after approving the rest of the file nothing is left drawn, and nothing unstaged', a.pills === 0 && a.zones === 0 && !git('diff', '--name-only').split('\n').includes('src/big.ts'), `${a.pills} widgets, ${a.zones} removed blocks; unstaged: ${git('diff', '--name-only').replace(/\n/g, ', ') || 'nothing'}`);
		check('no errors from the review in the console', errors.length === 0, errors.slice(0, 3).join(' | '));
	} catch (e) { check('the run finished', false, String(e && e.message || e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
