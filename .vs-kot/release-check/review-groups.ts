/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: are changes that are close to each other one approval, and does an approval save the file, so that the
// formatter runs on what another program wrote? Also in a burst of approvals, each of which is followed by a save.
// Drives the source build of the audit worktree, with a profile of its own and without tab completion.
//
//   node .vs-kot/release-check/review-groups.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedClaudeRecord, repo, scratch } from './isolated.ts';

const base = path.join(scratch, 'review-groups');
const ws = path.join(base, 'ws'); const ud = path.join(base, 'ud');
const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: ws, encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const line = (n: number) => `export const v${String(n).padStart(4, '0')} = ${n};`;
const original = Array.from({ length: 60 }, (_, i) => line(i + 1));
// "Claude": lines 5, 20, 28, 40 and 50 changed, and a badly formatted line added below line 6
const lines = original.map((text, i) => [5, 20, 28, 40, 50].includes(i + 1) ? text.replace(' = ', ' = 1000 + ') : text);
lines.splice(6, 0, 'export const added=true');

fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, 'src'), { recursive: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
const file = path.join(ws, 'src', 'near.ts');
fs.writeFileSync(file, original.join('\n') + '\n');
fs.writeFileSync(path.join(ws, 'src', 'burst.ts'), Array.from({ length: 80 }, (_, i) => line(i + 1)).join('\n') + '\n');
git('init', '-q', '.'); git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init');
fs.writeFileSync(file, lines.join('\n') + '\n');
// a second file with four changes far apart, none of them formatted
const burstFile = path.join(ws, 'src', 'burst.ts');
fs.writeFileSync(burstFile, Array.from({ length: 80 }, (_, i) => [5, 25, 45, 65].includes(i + 1) ? `export const v${String(i + 1).padStart(4, '0')}=1000+${i + 1}` : line(i + 1)).join('\n') + '\n');
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
	...getIsolatedClaudeRecord(),
	'changeReview.autoReveal': false, 'tabCompletion.enabled': false, 'editor.minimap.enabled': false
}));

setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 240000).unref();
const results: boolean[] = []; const check = (name: string, ok: boolean, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', VS_KOT_TAB_COMPLETION_HOME: path.join(base, 'tab-completion'), VS_KOT_TAB_COMPLETION_PORT: '11677' }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(base, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	const errors: string[] = [];
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		page.on('console', m => { if (m.type() === 'error' && /changeReview|ReviewedFile|view zone|Cannot read|is not a function/i.test(m.text())) { errors.push(m.text().slice(0, 200)); } });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await sleep(9000);
		await page.keyboard.press('Meta+p'); await sleep(500); await page.keyboard.type('near.ts', { delay: 5 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(4000);

		const drawn = () => page.evaluate(() => {
			const g = document.querySelector('.editor-group-container.active');
			const q = (s: string) => g ? [...g.querySelectorAll(s)] : [];
			const bar = (g?.querySelector('.change-review-bar-widget')?.textContent || '').trim();
			return { pills: q('.change-review-hunk-widget').length, zones: q('.change-review-removed-zone').length, bar: bar.slice(0, 30), dirty: !!g?.querySelector('.tab.active.dirty') };
		});
		const show = (d: Awaited<ReturnType<typeof drawn>>) => `${d.pills} approval(s), ${d.zones} removed block(s), bar "${d.bar}"${d.dirty ? ', unsaved' : ''}`;

		let d = await drawn();
		check('six changes show as three approvals: 1 and 7 unchanged lines apart are one, 11 are not', d.pills === 3 && d.zones === 5 && /^1 of 3/.test(d.bar), show(d));

		// Approve the first one with a click
		await page.locator('.editor-group-container.active .change-review-hunk-widget .monaco-button', { hasText: 'Approve' }).first().click(); await sleep(7000);
		d = await drawn();
		const disk = fs.readFileSync(file, 'utf8');
		const index = git('show', ':src/near.ts');
		check('the approval saved the file, and the formatter ran', disk.includes('export const added = true;') && !disk.includes('added=true') && !d.dirty, JSON.stringify(disk.split('\n').slice(4, 8)));
		check('both changes of the approval are staged, formatted', index.includes('v0005 = 1000 + 5;') && index.includes('export const added = true;') && !index.includes('v0020 = 1000'), JSON.stringify(index.split('\n').slice(4, 8)));
		check('what the formatter did is no new change to review', d.pills === 2 && d.zones === 4 && /^1 of 2/.test(d.bar), show(d));

		// Approve File for the rest
		await page.locator('.editor-group-container.active .change-review-bar-widget .monaco-button', { hasText: 'Approve File' }).first().click(); await sleep(7000);
		d = await drawn();
		const tab = await page.evaluate(() => document.querySelector('.editor-group-container.active .tab.active .label-name')?.textContent || '');
		check('Approve File stages the rest and goes on to the next file', git('diff', '--name-only') === 'src/burst.ts' && git('show', ':src/near.ts') + '\n' === fs.readFileSync(file, 'utf8') && tab === 'burst.ts', `unstaged: "${git('diff', '--name-only')}", in ${tab}: ${show(d)}`);
		// Four approvals by key within a second, each of them followed by a save
		d = await drawn();
		check('the second file shows four approvals', d.pills === 4, show(d));
		await page.keyboard.press('Meta+1'); await sleep(300);
		for (let i = 0; i < 4; i++) { await page.keyboard.press('Meta+z'); await sleep(170); }     // Cmd+Y on a German keyboard
		await sleep(9000); d = await drawn();
		const burstDisk = fs.readFileSync(burstFile, 'utf8');
		check('four approvals in a second approve four changes, and all of it is staged formatted', git('diff', '--name-only') === '' && git('show', ':src/burst.ts') + '\n' === burstDisk && [5, 25, 45, 65].every(n => burstDisk.includes(`= 1000 + ${n};`)) && d.pills === 0, `unstaged: "${git('diff', '--name-only')}", ${show(d)}, line 5 on disk: ${burstDisk.split('\n')[4]}`);
		check('no errors from the review in the console', errors.length === 0, errors.join(' | '));
	} finally {
		await app.close().catch(() => undefined);
	}
	console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
	process.exit(results.every(Boolean) ? 0 : 1);
})();
