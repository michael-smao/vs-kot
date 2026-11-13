/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: how does tab completion keep up with typing in a large file? Types at different rhythms and says how
// long after the last key the suggestion is there, and how many requests reached the model server for it. The
// model server works on one request at a time and reads a prompt to its end even after the request was cancelled.
// Before the editor held requests back for that, typing with a quarter of a second between keys sent 22 requests
// for one suggestion and waited 5.7 seconds for it.
//
// What is checked is the number of requests, which does not depend on the computer. The times are for reading.
// Reading ahead is switched off here: its requests would be counted with the ones for suggestions. It has its own
// check, read-ahead.ts.
//
//   node .vs-kot/release-check/typing.ts [model]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedClaudeRecord, getIsolatedModelServer, repo, scratch, stopIsolatedModelServer } from './isolated.ts';

const model = process.argv[2];
const root = path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
const ws = path.join(scratch, 'typing');
const isolated = getIsolatedModelServer();

fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.copyFileSync(path.join(repo, 'src/vs/editor/contrib/suggest/browser/suggestController.ts'), path.join(ws, 'src', 'big.ts'));
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ ...getIsolatedClaudeRecord(), 'changeReview.enabled': false, 'editor.formatOnSave': false, 'tabCompletion.readAhead': false, ...(model ? { 'tabCompletion.model': model } : {}) }));
// when the run takes too long, for example because the computer went to sleep, nothing of it is left running
let endEditor = () => { };
setTimeout(() => { console.log('HARD TIMEOUT'); endEditor(); stopIsolatedModelServer(); process.exit(2); }, 400000).unref();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const requestsAtServer = () => { try { return fs.readFileSync(path.join(isolated.VS_KOT_TAB_COMPLETION_HOME, 'server.log'), 'utf8').split('\n').filter(l => l.includes('[GIN]') && l.includes('/api/generate')).length; } catch { return 0; } };
const results: boolean[] = []; const check = (name: string, ok: boolean, detail: string) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`); };

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', ...isolated }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	endEditor = () => app.process().kill();
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
		const status = () => page.evaluate(() => [...document.querySelectorAll('.statusbar-item')].filter(s => /^Tab\b/.test(s.textContent.trim())).map(s => s.querySelector('.codicon')?.className.replace(/.*codicon-/, '') || '').join(' '));
		for (let i = 0; i < 160 && !/zap/.test(await status()); i++) { await sleep(500); }
		await page.keyboard.press('Meta+p'); await sleep(500); await page.keyboard.type('big.ts', { delay: 5 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(2500);
		const ghost = () => page.evaluate(() => [...document.querySelectorAll('[class*="ghost-text"]')].map(e => e.textContent).join('').trim());
		const newLine = async (n: number) => { await page.keyboard.press('Escape'); await page.keyboard.press('Meta+1'); await page.keyboard.press('Control+g'); await sleep(400); await page.keyboard.type(String(n), { delay: 10 }); await page.keyboard.press('Enter'); await sleep(300); await page.keyboard.press('End'); await page.keyboard.press('Enter'); };
		const waitGhost = async (ms: number) => { const t = Date.now(); let g = ''; while (Date.now() - t < ms) { g = await ghost(); if (g) { break; } await sleep(15); } return { g, ms: Date.now() - t }; };
		// types text with a gap between the keys, then waits for the suggestion
		const run = async (line: number, text: string, gap: number) => {
			await newLine(line); await sleep(1500);
			const before = requestsAtServer();
			for (const character of text) { await page.keyboard.type(character); await sleep(gap); }
			const s = await waitGhost(20000); await sleep(400);
			return { hasSuggestion: !!s.g, ms: s.ms + gap, requests: requestsAtServer() - before };
		};

		// the place is made known to the server first: the runs measure typing, not the first read of the file
		await newLine(500); await page.keyboard.type('const warm = ', { delay: 40 }); await waitGhost(30000); await sleep(500);

		let r = await run(520, 'const selectionRange = this.editor.', 80);
		// one for the end of the typing; a second one can slip in where the keys of this script come a little late
		check('typing steadily, a key every 80 ms: nothing is sent while the typing goes on', r.hasSuggestion && r.requests <= 3, `${r.requests} request(s) reached the server for 35 keys; suggestion ${r.ms} ms after the last key`);
		r = await run(540, 'const lineCount = this.', 260);
		check('typing with short breaks, a key every 260 ms: requests do not pile up', r.hasSuggestion && r.requests <= 6, `${r.requests} request(s) reached the server for 23 keys; suggestion ${r.ms} ms after the last key`);
		r = await run(560, 'const focusedItem = this.', 260);
		check('the same again, where the server knows the code by now', r.hasSuggestion && r.requests <= 6, `${r.requests} request(s) reached the server for 24 keys; suggestion ${r.ms} ms after the last key`);
		r = await run(580, 'const column = pos', 400);
		check('typing slowly, a key every 400 ms: at most one request per key', r.hasSuggestion && r.requests <= 18, `${r.requests} request(s) reached the server for 18 keys; suggestion ${r.ms} ms after the last key`);
	} catch (e) { check('the run finished', false, String(e instanceof Error ? e.message : e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	// the checks' own model server is not left running
	stopIsolatedModelServer();
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
