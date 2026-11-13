/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: are the statistics of tab completion right? Types in the editor, takes suggestions with Tab, word by
// word and not at all, and reads the numbers from the Tab Completion view after every step: a suggestion counts
// once however long it is typed along with, and the characters are the ones that Tab wrote. Then the editor is
// started again, to see that the numbers were kept, and they are reset.
//
//   node .vs-kot/release-check/usage.ts            the source build
//   PACKAGED_APP=<path to vs-kot.app> node .vs-kot/release-check/usage.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { getIsolatedClaudeRecord, getIsolatedModelServer, repo, scratch, stopIsolatedModelServer } from './isolated.ts';

const packagedApp = process.env.PACKAGED_APP;
// A profile of its own, so that this check can run next to another one. The path has to be short.
const root = path.join(repo, '.build', 'usage-check'); const ud = path.join(root, 'ud');
const ws = path.join(scratch, 'usage');
const isolated = getIsolatedModelServer();

fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
// Every place that is typed at has a line after it, so that a suggestion is the rest of one line
fs.writeFileSync(path.join(ws, 'src', 'items.ts'), [
	'export interface Item { name: string; price: number; quantity: number; }',
	'',
	'export function getNames(items: Item[]): string[] {',
	'    const names = items.map(item => item.name);',
	'    return names;',
	'}',
	'',
	'export function getPrices(items: Item[]): number[] {',
	'    const prices = ',
	'    return prices;',
	'}',
	'',
	'export function getQuantities(items: Item[]): number[] {',
	'    const quantities = ',
	'    return quantities;',
	'}',
	'',
	'export function getTotal(items: Item[]): number {',
	'    const total = ',
	'    return total;',
	'}',
	''
].join('\n'));
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
// The question before a reset has to be one that this script can answer: the editor's own dialog, not the one of macOS
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ ...getIsolatedClaudeRecord(), 'changeReview.enabled': false, 'tabCompletion.readAhead': false, 'window.dialogStyle': 'custom' }));

// when the run takes too long, for example because the computer went to sleep, nothing of it is left running
let endEditor = () => { };
setTimeout(() => { console.log('HARD TIMEOUT'); endEditor(); stopIsolatedModelServer(); process.exit(2); }, 400000).unref();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: boolean[] = []; const check = (name: string, ok: boolean, detail: string) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`); };

/** The numbers of one span of time, as the view shows them. */
interface IShown { suggestions: number; accepted: number; rate: string; lines: number; characters: number }

async function start(): Promise<{ app: ElectronApplication; page: Page }> {
	const env: Record<string, string | undefined> = { ...process.env, ...isolated }; delete env.ELECTRON_RUN_AS_NODE;
	if (packagedApp) { delete env.VSCODE_DEV; delete env.NODE_ENV; delete env.VSCODE_CLI; } else { Object.assign(env, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }); }
	const app = await _electron.launch({ executablePath: packagedApp ? path.join(packagedApp, 'Contents', 'MacOS', 'vs-kot') : path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [...(packagedApp ? [] : [repo]), ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	endEditor = () => app.process().kill();
	const page = await app.firstWindow({ timeout: 120000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
	const status = () => page.evaluate(() => [...document.querySelectorAll('.statusbar-item')].filter(s => /^Tab\b/.test(s.textContent!.trim())).map(s => s.querySelector('.codicon')?.className.replace(/.*codicon-/, '') || '').join(' '));
	for (let i = 0; i < 160 && !/zap/.test(await status()); i++) { await sleep(500); }
	// The view stays open at the side while the editor is typed in. An editor that is started again has it open
	// already, and a click on its icon would close it.
	await sleep(1500);
	if (!await page.isVisible('.tab-completion-view')) {
		await page.click('.activitybar .action-label.codicon-tab-completion-view-icon');
	}
	await page.waitForSelector('.tab-completion-usage tbody tr', { timeout: 30000 });
	return { app, page };
}

async function stop(app: ElectronApplication): Promise<void> {
	await Promise.race([app.close(), sleep(15000)]);
	try { app.process().kill(); } catch { /* gone already */ }
}

/** Reads the statistics from the view: one set of numbers per column. */
async function read(page: Page): Promise<{ today: IShown; week: IShown; total: IShown; hint: string }> {
	const { cells, hint } = await page.evaluate(() => ({
		cells: [...document.querySelectorAll('.tab-completion-usage tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent ?? '')),
		hint: document.querySelector('.tab-completion-usage + .tab-completion-hint')?.textContent ?? ''
	}));
	const number = (text: string) => Number(text.replace(/[^\d]/g, ''));
	const column = (index: number): IShown => ({ suggestions: number(cells[0][index]), accepted: number(cells[1][index]), rate: cells[2][index], lines: number(cells[3][index]), characters: number(cells[4][index]) });
	return { today: column(0), week: column(1), total: column(2), hint };
}

(async () => {
	let { app, page } = await start();
	try {
		const ghost = () => page.evaluate(() => [...document.querySelectorAll('.view-line [class*="ghost-text"]')].map(e => e.textContent!.replace(/ /g, ' ')).join(''));
		const waitGhost = async (ms: number) => { const t = Date.now(); let g = ''; while (Date.now() - t < ms) { g = await ghost(); if (g.trim()) { break; } await sleep(20); } return g; };
		/** The text of the line the cursor is in, without a suggestion that is shown in it. */
		const line = () => page.evaluate(() => {
			const top = (document.querySelector('.editor-instance .cursors-layer .cursor') as HTMLElement | null)?.style.top;
			const current = [...document.querySelectorAll('.editor-instance .view-lines .view-line')].find(l => (l as HTMLElement).style.top === top)?.cloneNode(true) as HTMLElement | undefined;
			current?.querySelectorAll('[class*="ghost-text"]').forEach(e => e.remove());
			return (current?.textContent ?? '').replace(/ /g, ' ');
		});
		const goTo = async (lineNumber: number) => { await page.keyboard.press('Escape'); await page.keyboard.press('Meta+1'); await page.keyboard.press('Control+g'); await sleep(400); await page.keyboard.type(String(lineNumber), { delay: 10 }); await page.keyboard.press('Enter'); await sleep(300); await page.keyboard.press('End'); };
		/** Waits until the view shows what is expected, and says what it shows in the end. */
		const settle = async (isThere: (today: IShown) => boolean) => { let shown = await read(page); for (let i = 0; i < 40 && !isThere(shown.today); i++) { await sleep(100); shown = await read(page); } return shown; };

		await page.keyboard.press('Meta+p'); await sleep(500); await page.keyboard.type('items.ts', { delay: 5 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(2500);
		const start0 = await read(page);
		check('nothing is counted before anything was suggested', start0.total.suggestions === 0 && start0.total.accepted === 0 && start0.today.rate === '–' && /\d/.test(start0.hint), `${JSON.stringify(start0.total)}; "${start0.hint}"`);

		// --- a suggestion that is typed along with and then taken
		await goTo(9); await page.keyboard.type('items.', { delay: 40 });
		const first = await waitGhost(40000);
		let shown = await settle(today => today.suggestions === 1);
		check('a suggestion that appears is counted', first.trim().length > 3 && shown.today.suggestions === 1 && shown.today.accepted === 0 && shown.today.rate === '0%', `suggested "${first}"; ${JSON.stringify(shown.today)}`);

		await page.keyboard.type(first.slice(0, 2), { delay: 150 }); await sleep(1500);
		const rest = await ghost();
		shown = await read(page);
		check('typing along with it does not make it a new suggestion', rest === first.slice(2) && shown.today.suggestions === 1, `still suggested "${rest}"; ${JSON.stringify(shown.today)}`);

		let before = await line();
		await page.keyboard.press('Tab');
		shown = await settle(today => today.accepted === 1);
		let written = (await line()).length - before.length;
		check('Tab counts one accepted suggestion, one line, and the characters it wrote', shown.today.accepted === 1 && shown.today.lines === 1 && written > 0 && shown.today.characters === written && written === rest.length, `Tab wrote ${written} characters, the rest of the suggestion had ${rest.length}; ${JSON.stringify(shown.today)}`);

		// --- a suggestion that is not taken
		await goTo(14); await sleep(1500);
		const suggestionsBefore = (await read(page)).today.suggestions;
		await page.keyboard.type('items.', { delay: 40 });
		const second = await waitGhost(40000); await sleep(400);
		await page.keyboard.press('Escape'); await sleep(600);
		shown = await read(page);
		check('a suggestion that is not taken counts as shown only', second.trim().length > 0 && shown.today.suggestions === suggestionsBefore + 1 && shown.today.accepted === 1 && shown.today.rate === `${Math.round(100 / shown.today.suggestions)}%`, `suggested "${second}"; ${JSON.stringify(shown.today)}`);

		// --- a suggestion that is taken word by word, and its rest with Tab
		await goTo(19); await sleep(1500);
		const charactersBefore = (await read(page)).today.characters;
		await page.keyboard.type('items.', { delay: 40 });
		const third = await waitGhost(40000); await sleep(400);
		before = await line();
		await page.keyboard.press('Meta+ArrowRight');
		shown = await settle(today => today.accepted === 2);
		const word = (await line()).length - before.length;
		const afterWord = { ...shown.today };
		await sleep(1200); // the rest of the suggestion is shown again
		await page.keyboard.press('Tab');
		shown = await settle(today => today.characters > afterWord.characters);
		written = (await line()).length - before.length;
		check('a suggestion taken word by word is one accepted suggestion', word > 0 && word < third.length && afterWord.accepted === 2 && afterWord.characters === charactersBefore + word && shown.today.accepted === 2 && shown.today.lines === 2 && shown.today.characters === charactersBefore + written, `suggested "${third}"; the word had ${word} characters, all of it ${written}; after the word ${JSON.stringify(afterWord)}, after Tab ${JSON.stringify(shown.today)}`);
		check('today, the last seven days and all time agree on the first day', JSON.stringify(shown.today) === JSON.stringify(shown.week) && JSON.stringify(shown.today) === JSON.stringify(shown.total), JSON.stringify(shown.total));

		// --- the numbers are kept: they are there again in an editor that is started anew
		await sleep(3000);
		const kept = await read(page);
		await stop(app);
		({ app, page } = await start());
		const again = await settle(today => today.suggestions === kept.today.suggestions);
		check('the numbers are there again after a restart', JSON.stringify(again.total) === JSON.stringify(kept.total) && again.total.accepted === 2, `before ${JSON.stringify(kept.total)}, after ${JSON.stringify(again.total)}`);

		// --- reset
		await page.keyboard.press('F1'); await sleep(600); await page.keyboard.type('Tab Completion: Reset Statistics', { delay: 10 }); await sleep(1200); await page.keyboard.press('Enter');
		await page.waitForSelector('.monaco-dialog-box', { timeout: 10000 });
		const question = await page.evaluate(() => document.querySelector('.monaco-dialog-box .dialog-message-text')?.textContent ?? '');
		await page.click('.monaco-dialog-box .dialog-buttons .monaco-button:has-text("Reset")');
		const reset = await settle(today => today.suggestions === 0);
		check('Reset Statistics asks first and then starts at zero', /statistics/i.test(question) && reset.total.suggestions === 0 && reset.total.accepted === 0 && reset.total.characters === 0 && reset.today.rate === '–', `asked "${question}"; ${JSON.stringify(reset.total)}`);
	} catch (e) { check('the run finished', false, String(e instanceof Error ? e.message : e).slice(0, 300)); }
	await stop(app);
	// the checks' own model server is not left running
	stopIsolatedModelServer();
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
