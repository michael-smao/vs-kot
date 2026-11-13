/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: reading ahead. At a place the model server has not read yet, a suggestion takes seconds, nearly all of
// them for reading the code before the cursor. So the server is given that code before a suggestion is asked for:
// as soon as typing starts at such a place, and when the cursor rests at one shortly after something was typed.
//
// What is checked is which requests reach the model server and when, and how much the request for a suggestion
// has left to read, as the model server logs it. Neither depends on the computer. The times are for reading: how
// long a suggestion takes also depends on how long it is.
//
//   node .vs-kot/release-check/read-ahead.ts [model]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedClaudeRecord, getIsolatedModelServer, repo, scratch, stopIsolatedModelServer } from './isolated.ts';

const model = process.argv[2];
const root = path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
const ws = path.join(scratch, 'read-ahead');
const isolated = getIsolatedModelServer();

// A large file together with the files it imports: code from those is the start of every prompt, and read ahead too
const source = path.join(repo, 'src/vs/editor/contrib/suggest/browser');
fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
for (const entry of fs.readdirSync(source, { withFileTypes: true })) { if (entry.isFile() && entry.name.endsWith('.ts')) { fs.copyFileSync(path.join(source, entry.name), path.join(ws, 'src', entry.name)); } }
fs.copyFileSync(path.join(source, 'suggestController.ts'), path.join(ws, 'src', 'big.ts'));
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
const writeSettings = (readAhead: boolean) => fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ ...getIsolatedClaudeRecord(), 'changeReview.enabled': false, 'editor.formatOnSave': false, 'tabCompletion.readAhead': readAhead, ...(model ? { 'tabCompletion.model': model } : {}) }));
writeSettings(true);
// when the run takes too long, for example because the computer went to sleep, nothing of it is left running
let endEditor = () => { };
setTimeout(() => { console.log('HARD TIMEOUT'); endEditor(); stopIsolatedModelServer(); process.exit(2); }, 400000).unref();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const serverLog = () => { try { return fs.readFileSync(path.join(isolated.VS_KOT_TAB_COMPLETION_HOME, 'server.log'), 'utf8').split('\n'); } catch { return []; } };
const requestsAtServer = () => serverLog().filter(l => l.includes('[GIN]') && l.includes('/api/generate')).length;
/** How many tokens the model had to read for the request it answered last, and how long that took. */
const lastRead = () => { const read = /prompt eval time =\s*(?<ms>[\d.]+) ms \/\s*(?<tokens>\d+) tokens/.exec(serverLog().filter(l => l.includes('prompt eval time')).at(-1) ?? ''); return { tokens: Number(read?.groups?.tokens ?? NaN), ms: Math.round(Number(read?.groups?.ms ?? NaN)) }; };
/** In how many requests a place was read ahead that the cursor rested at long enough. */
let piecesOfAPlace = 4;
const results: boolean[] = []; const check =(name: string, ok: boolean, detail: string) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`); };
/** What tab completion wrote into its log about reading ahead. */
const logLines = () => {
	const lines: string[] = [];
	const visit = (folder: string) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isDirectory()) { visit(file); } else if (entry.name.endsWith('Tab Completion.log')) { lines.push(...fs.readFileSync(file, 'utf8').split('\n')); } } };
	try { visit(path.join(ud, 'logs')); } catch { }
	return lines;
};

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', ...isolated }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--log=vs-kot.tab-completion:trace', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	endEditor = () => app.process().kill();
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
		const status = () => page.evaluate(() => [...document.querySelectorAll('.statusbar-item')].filter(s => /^Tab\b/.test(s.textContent.trim())).map(s => s.querySelector('.codicon')?.className.replace(/.*codicon-/, '') || '').join(' '));
		for (let i = 0; i < 160 && !/zap/.test(await status()); i++) { await sleep(500); }
		await page.keyboard.press('Meta+p'); await sleep(500); await page.keyboard.type('big.ts', { delay: 5 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(2500);
		const ghost = () => page.evaluate(() => [...document.querySelectorAll('[class*="ghost-text"]')].map(e => e.textContent).join('').trim());
		// moves the cursor to the end of a line, without typing anything
		const goTo = async (n: number) => { await page.keyboard.press('Escape'); await page.keyboard.press('Meta+1'); await page.keyboard.press('Control+g'); await sleep(400); await page.keyboard.type(String(n), { delay: 10 }); await page.keyboard.press('Enter'); await sleep(300); await page.keyboard.press('End'); };
		const waitGhost = async (ms: number) => { const t = Date.now(); let g = ''; while (Date.now() - t < ms) { g = await ghost(); if (g) { break; } await sleep(15); } return { g, ms: Date.now() - t }; };
		// opens a new line and types into it with a gap between the keys, then waits for the suggestion
		const typeLine = async (text: string, gap: number) => {
			const before = requestsAtServer();
			await page.keyboard.press('Enter');
			for (const character of text) { await page.keyboard.type(character); await sleep(gap); }
			const whileTyping = requestsAtServer() - before;
			const s = await waitGhost(20000); await sleep(400);
			return { hasSuggestion: !!s.g, ms: s.ms + gap, whileTyping, requests: requestsAtServer() - before, read: lastRead() };
		};
		const line = 'const selectionRange = this.editor.';

		// Each place below is one the server has not read: they are further apart than the code that is sent for one.
		let before = requestsAtServer();
		await goTo(200); await sleep(3500);
		check('before anything was typed, a resting cursor has nothing read', requestsAtServer() - before === 0, `${requestsAtServer() - before} request(s) reached the server`);

		// the code from other files, which every prompt of this file starts with, is read here once
		await goTo(40); await page.keyboard.press('Enter'); await page.keyboard.type('const warm = ', { delay: 40 }); await waitGhost(30000); await sleep(1500);

		await goTo(330);
		const typed = await typeLine(line, 80);
		check('typing at a new place: the server reads while the typing goes on', typed.hasSuggestion && typed.whileTyping >= 2, `${typed.whileTyping} request(s) answered before the last of ${line.length} keys; suggestion ${typed.ms} ms after it`);

		before = requestsAtServer();
		await goTo(620); await sleep(6000);
		const atRest = requestsAtServer() - before;
		piecesOfAPlace = atRest;
		const rested = await typeLine(line, 30);
		check('the cursor rests at a new place after typing: the server reads the code there', atRest >= 2, `${atRest} request(s) reached the server while nothing was typed`);
		check('typing there afterwards sends the request for the suggestion and no more', rested.hasSuggestion && rested.requests <= 3, `${rested.requests} request(s), suggestion ${rested.ms} ms after the last key`);

		// typing with short breaks: in each of them a request for a suggestion comes up beside the reading ahead
		await goTo(480);
		const hesitant = await typeLine('const lineCount = this.', 260);

		// The cursor rests just long enough for reading to start, and leaves with one key, for the top of the file,
		// where there is nothing to read: a small model has read a place within a second. Then back to the place
		// before. The model server kept a copy of what it read there, but with the little it has at hand of the
		// place that was left, it does not look for that copy: the place has to be read again.
		await goTo(900); await sleep(550); await page.keyboard.press('Meta+ArrowUp'); await sleep(1500);
		before = requestsAtServer();
		await goTo(482); await sleep(5000);
		const readAgain = requestsAtServer() - before;
		const again = await typeLine(line, 30);

		// And on to the place where typing started first. Now the server has a whole place at hand, and fetches its
		// copy. Nothing was typed above that place since: a line more further up moves the start of the code that
		// is sent for every place below it, which is new to the server then.
		before = requestsAtServer();
		await goTo(332); await sleep(3500);
		const fetched = { requests: requestsAtServer() - before, read: lastRead() };
		const afterwards = await typeLine(line, 30);

		writeSettings(false); await sleep(2500);
		before = requestsAtServer();
		await goTo(1040); await sleep(4000);
		const whenOff = requestsAtServer() - before;
		const cold = await typeLine(line, 80);
		check('switched off, nothing is read ahead', whenOff === 0 && cold.whileTyping <= 1, `${whenOff} request(s) while the cursor rested, ${cold.whileTyping} answered while typing`);
		const said = (r: typeof cold) => `${r.read.tokens} tokens in ${r.read.ms} ms (suggestion after ${r.ms} ms)`;
		check('with reading ahead, the request for a suggestion at a new place has little left to read', cold.hasSuggestion && typed.read.tokens < cold.read.tokens * 0.4 && rested.read.tokens < cold.read.tokens * 0.4, `where typing started: ${said(typed)}; where the cursor rested: ${said(rested)}; without: ${said(cold)}`);
		check('the same when typing with short breaks, a key every 260 ms', hesitant.hasSuggestion && hesitant.read.tokens < cold.read.tokens * 0.4 && hesitant.requests <= 12, `${said(hesitant)}, ${hesitant.requests} request(s) for 23 keys`);
		check('back at an earlier place that the server would read anew: it is read ahead again', readAgain >= 2 && again.hasSuggestion && again.read.tokens < cold.read.tokens * 0.4, `${readAgain} request(s) while the cursor rested; then ${said(again)}`);
		check('back at an earlier place that the server kept a copy of: one request has it fetched', fetched.requests === 1 && fetched.read.tokens < cold.read.tokens * 0.4 && afterwards.hasSuggestion && afterwards.read.tokens < cold.read.tokens * 0.4, `${fetched.requests} request(s) while the cursor rested, with ${fetched.read.tokens} tokens to read; then ${said(afterwards)}`);
	} catch (e) { check('the run finished', false, String(e instanceof Error ? e.message : e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	// the checks' own model server is not left running
	stopIsolatedModelServer();
	// the place the cursor left after 0.7 seconds, as tab completion logged it
	const left = logLines().map(l => /reading ahead ended after (?<pieces>\d+) piece\(s\): the cursor went on/.exec(l)?.groups?.pieces).filter(Boolean).map(Number);
	check('the cursor moves on: reading ahead ends with the piece it is at', left.length > 0 && left.every(pieces => pieces < piecesOfAPlace), `ended after ${left.join(', ') || 'no'} piece(s); a place that is read to its end takes ${piecesOfAPlace}`);
	const log = logLines();
	for (const l of log.filter(l => /read(ing)? ahead/.test(l))) { console.log('   log: ' + l.replace(/^\S+ \S+ /, '').slice(0, 200)); }
	console.log('   other files in the prompts: ' + ([...new Set(log.map(l => /(?<count>\d+) other files/.exec(l)?.groups?.count).filter(Boolean))].join(', ') || 'not logged'));
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
