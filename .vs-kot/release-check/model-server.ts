/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: what happens to tab completion when its model server misbehaves? Runs the source build of the audit worktree
// against a model server of its own (own port, own folder), so that the server the user works with is left alone.
//
//   node .vs-kot/release-check/model-server.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedClaudeRecord, ISOLATED_PORT, realModelServerHome, repo, scratch } from './isolated.ts';

const realHome = realModelServerHome;
const PORT = ISOLATED_PORT; const MODEL = 'qwen2.5-coder:1.5b-base';
fs.mkdirSync(scratch, { recursive: true });
const root = path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
const sh = (cmd) => { try { return cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const listening = () => sh(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`).split('\n').filter(Boolean)[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
setTimeout(() => { console.log('HARD TIMEOUT'); const p = listening(); if (p) { try { process.kill(Number(p)); } catch { } } process.exit(2); }, 420000).unref();

// --- a pretend home folder in which the editor of the former name left its downloads and a running server
const home = path.join(scratch, 'fh'); const legacy = path.join(home, '.vs-claude', 'tab-completion'); const current = path.join(home, '.vs-kot', 'tab-completion');
// The port is the checks' own: a server that an earlier check left running on it is ended
for (let i = 0; i < 20 && listening(); i++) { try { process.kill(Number(listening())); } catch { } cp.execSync('sleep 0.3'); }
if (listening()) { console.log('the port of the checks is in use, aborting'); process.exit(2); }
fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(legacy, { recursive: true });
fs.symlinkSync(path.join(realHome, 'runtime'), path.join(legacy, 'runtime')); fs.symlinkSync(path.join(realHome, 'models'), path.join(legacy, 'models'));
const oldLog = fs.openSync(path.join(legacy, 'server.log'), 'a');
const old = cp.spawn(path.join(legacy, 'runtime', '0.40.16', 'ollama'), ['serve'], { detached: true, stdio: ['ignore', oldLog, oldLog], env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', OLLAMA_HOST: `127.0.0.1:${PORT}`, OLLAMA_MODELS: path.join(legacy, 'models'), OLLAMA_KEEP_ALIVE: '30m', OLLAMA_NO_CLOUD: '1' } });
old.unref(); fs.writeFileSync(path.join(legacy, 'server.pid'), String(old.pid));   // the way release 0.4.0 left it

const ws = path.join(scratch, 'srvws'); fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, 'a.ts'), 'export interface Item { name: string; price: number; qty: number; }\n\nexport function total(items: Item[]): number {\n    return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n\n');
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ ...getIsolatedClaudeRecord(), 'tabCompletion.model': MODEL, 'changeReview.enabled': false }));

(async () => {
	for (let i = 0; i < 50 && !listening(); i++) { await sleep(200); }
	const oldPid = listening();
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', VS_KOT_TAB_COMPLETION_PORT: String(PORT) }; delete env.ELECTRON_RUN_AS_NODE; delete env.VS_KOT_TAB_COMPLETION_HOME;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain', '--log=debug'], env, timeout: 120000 });
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
		const status = () => page.evaluate(() => [...document.querySelectorAll('.statusbar-item')].filter(s => /^Tab\b/.test(s.textContent.trim())).map(s => `${s.textContent.trim()}|${s.querySelector('.codicon')?.className.replace(/.*codicon-/, '') || ''}`).join(' '));
		const waitReady = async ms => { const t = Date.now(); while (Date.now() - t < ms) { if (/^Tab\|zap/.test(await status())) { return Date.now() - t; } await sleep(250); } return -1; };
		const run = async name => { await page.keyboard.press('F1'); await sleep(500); await page.keyboard.type(name, { delay: 4 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(600); };
		const ghost = () => page.evaluate(() => [...document.querySelectorAll('[class*="ghost-text"]')].map(e => e.textContent).join('').trim());
		let line = 6;
		// types the start of a function and waits for a suggestion; keeps typing a little, as someone would
		const suggest = async ms => { await page.keyboard.press('Escape'); await page.keyboard.press('Meta+1'); await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.press('Enter'); await page.keyboard.type(`export function names${line++}(items: Item[]): string[] {`, { delay: 20 }); await page.keyboard.press('Enter'); const t = Date.now(); let g = ''; while (Date.now() - t < ms) { g = await ghost(); if (g) { break; } await sleep(50); } return { g, ms: Date.now() - t }; };

		// 1. taking over from the editor of the former name
		const ready = await waitReady(60000);
		const newPid = listening();
		const descriptor = fs.existsSync(path.join(current, 'server.json')) ? JSON.parse(fs.readFileSync(path.join(current, 'server.json'), 'utf8')) : undefined;
		const isLink = (() => { try { return fs.lstatSync(legacy).isSymbolicLink(); } catch { return false; } })();
		check('the downloads of the former name are taken over, not fetched again, and a link is left at the old place', fs.existsSync(path.join(current, 'models')) && isLink && fs.realpathSync(legacy) === fs.realpathSync(current), `folder now: ${fs.existsSync(current) ? '.vs-kot' : 'missing'}, old place: ${isLink ? 'a link to it' : 'not a link'}`);
		check('the server that the old release left running is replaced by one with the new settings', ready >= 0 && newPid && newPid !== oldPid && descriptor && String(descriptor.pid) === newPid && descriptor.launch === 2, `old process ${oldPid}, now ${newPid}; ready after ${ready} ms; note ${JSON.stringify(descriptor)}`);
		const envOf = pid => sh(`ps eww -o command= -p ${pid}`).split(' ').filter(x => /^(OLLAMA_|LLAMA_)/.test(x)).sort().join(' ');
		const serverEnv = envOf(newPid);
		check('server settings: fixed context, one request at a time, one model, capped prompt memory', /OLLAMA_CONTEXT_LENGTH=8192/.test(serverEnv) && /OLLAMA_NUM_PARALLEL=1/.test(serverEnv) && /OLLAMA_MAX_LOADED_MODELS=1/.test(serverEnv) && /LLAMA_ARG_CACHE_RAM=\d+/.test(serverEnv), serverEnv.replace(/OLLAMA_MODELS=\S+ ?/, ''));

		await page.keyboard.press('Meta+p'); await sleep(500); await page.keyboard.type('a.ts', { delay: 5 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(2500);
		let s = await suggest(15000);
		check('a suggestion arrives', !!s.g, `${s.ms} ms: ${s.g.replace(/\s+/g, ' ').slice(0, 50)}`);
		const runner = sh(`ps -o command= -p $(pgrep -P ${newPid} | head -1)`);
		const log = () => fs.readFileSync(path.join(current, 'server.log'), 'utf8');
		check('the model runner has the fixed context and the capped prompt memory', /-c 8192 -np 1/.test(runner) && /prompt cache is enabled, size limit: (\d+) MiB/.test(log()) && Number(log().match(/size limit: (\d+) MiB/)[1]) <= 2048, `${(runner.match(/-c \d+ -np \d+/) || [''])[0]}; ${(log().match(/prompt cache is enabled, size limit: \d+ MiB/) || ['no cache line'])[0]}`);

		// 2. the server dies while the window is open
		process.kill(Number(listening()), 'SIGKILL'); await sleep(800);
		let t = Date.now(); s = await suggest(4000); let recovered = s.g ? 0 : -1;
		for (let i = 0; i < 6 && !s.g; i++) { s = await suggest(8000); }
		recovered = s.g ? Date.now() - t : -1;
		check('after the server is killed, typing brings it back and suggestions return', recovered >= 0 && !!listening(), recovered >= 0 ? `suggestions again ${recovered} ms after the first keystroke; status "${await status()}"` : `no suggestion; status "${await status()}"`);

		// 3. killed twice in a row
		process.kill(Number(listening()), 'SIGKILL'); await sleep(500); await suggest(1500);
		for (let i = 0; i < 40 && !listening(); i++) { await sleep(250); }
		if (listening()) { process.kill(Number(listening()), 'SIGKILL'); } await sleep(500);
		t = Date.now(); s = { g: '' }; for (let i = 0; i < 8 && !s.g; i++) { s = await suggest(8000); }
		check('killed twice in a row, it still comes back', !!s.g && !!listening(), s.g ? `suggestions again after ${Date.now() - t} ms` : `no suggestion after ${Date.now() - t} ms; status "${await status()}"`);

		// 4. stopped on purpose stays stopped
		await page.keyboard.press('Escape'); await run('Tab Completion: Stop Model Server'); await sleep(2500);
		const stoppedStatus = await status();
		await suggest(2500); await suggest(2500); await sleep(1500);
		check('stopped on purpose, it stays stopped while typing goes on', !listening() && /debug-pause/.test(stoppedStatus) && fs.existsSync(path.join(current, 'stopped')), `status "${stoppedStatus}", listening: ${listening() || 'nothing'}`);
		await page.keyboard.press('Escape'); await run('Tab Completion: Set Up');
		const again = await waitReady(60000); s = await suggest(15000);
		check('starting it again works', again >= 0 && !!s.g && !fs.existsSync(path.join(current, 'stopped')), `ready after ${again} ms; suggestion: ${!!s.g}`);

		// 5. each start writes a new log and keeps the one before
		check('a new log per start, the previous one kept', fs.existsSync(path.join(current, 'server.log.old')) && fs.statSync(path.join(current, 'server.log')).size < 2000000, `server.log ${fs.statSync(path.join(current, 'server.log')).size} bytes, server.log.old ${fs.existsSync(path.join(current, 'server.log.old')) ? fs.statSync(path.join(current, 'server.log.old')).size + ' bytes' : 'missing'}`);
	} catch (e) { check('the run finished', false, String(e && e.message || e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	const left = listening(); if (left) { try { process.kill(Number(left)); } catch { } }
	const tabLog = sh(`find "${path.join(ud, 'logs')}" -name "*Tab Completion*" | head -1`);
	if (tabLog) { console.log('--- what the extension logged'); console.log(fs.readFileSync(tabLog, 'utf8').split('\n').filter(l => /Took over|Replacing|Started the model server|Stopped the model|No answer|Using|could not|error/i.test(l)).map(l => '   ' + l.replace(/^\S+ \S+ /, '').slice(0, 170)).slice(0, 16).join('\n')); }
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
