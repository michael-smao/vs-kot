/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the model that tab completion uses when none is set, and what becomes of a computer that was set up
// with another one. The default is the small Qwen2.5-Coder 1.5B. Up to release 0.5.3 it was the 7B: a Mac that was
// set up until then has the 7B and not the 1.5B. After an update, tab completion has to go on working there with
// the 7B, offer the move to the default once, and move when that is asked for.
//
// Each case gets a model store of its own, made of links to the downloaded models, one link per file. A model
// server deletes from its store what no model in it needs: with links it deletes links, and with the folder of
// the downloaded models linked as a whole it would delete the other model.
//
// "Switch" has the model server ask the registry for the list of the model's parts, so this check needs the
// network. The parts themselves are linked into the store before, and nothing large is downloaded.
//
// Both models have to be set up on this Mac, which needs 16 GB of memory or more for the 7B.
//
//   node .vs-kot/release-check/default-model.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedClaudeRecord, ISOLATED_PORT, realModelServerHome, repo, scratch, stopIsolatedModelServer } from './isolated.ts';

const SMALL = 'qwen2.5-coder:1.5b-base'; const LARGE = 'qwen2.5-coder:7b-base';
const root = path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
const ws = path.join(scratch, 'default-model');
const home = path.join(scratch, 'tab-completion-store');
const library = path.join('models', 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5-coder');
const endpoint = `http://127.0.0.1:${ISOLATED_PORT}`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: boolean[] = []; const check = (name: string, ok: boolean, detail: string) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`); };
let endEditor = () => { };
setTimeout(() => { console.log('HARD TIMEOUT'); endEditor(); stopIsolatedModelServer(); process.exit(2); }, 420000).unref();

/** Puts a downloaded model into the store of the check: links to its parts, and the list of them unless the model server is to fetch that. */
function addModel(name: string, withList = true): void {
	const tag = name.split(':')[1];
	const list = JSON.parse(fs.readFileSync(path.join(realModelServerHome, library, tag), 'utf8')) as { config: { digest: string }; layers: { digest: string }[] };
	fs.mkdirSync(path.join(home, 'models', 'blobs'), { recursive: true }); fs.mkdirSync(path.join(home, library), { recursive: true });
	for (const digest of [list.config.digest, ...list.layers.map(layer => layer.digest)]) {
		const file = digest.replace(':', '-'); const link = path.join(home, 'models', 'blobs', file);
		fs.rmSync(link, { force: true }); fs.symlinkSync(path.join(realModelServerHome, 'models', 'blobs', file), link);
	}
	if (withList) { fs.copyFileSync(path.join(realModelServerHome, library, tag), path.join(home, library, tag)); }
}
/** A model store with the given models and nothing else, and no model server running on it. */
async function makeStore(...models: string[]): Promise<void> {
	stopIsolatedModelServer();
	for (let i = 0; i < 40; i++) { try { await fetch(`${endpoint}/api/version`, { signal: AbortSignal.timeout(500) }); await sleep(250); } catch { break; } }
	fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true });
	fs.symlinkSync(path.join(realModelServerHome, 'runtime'), path.join(home, 'runtime'));
	for (const model of models) { addModel(model); }
}
/** The model that the model server has in memory, which is the one that answered last. */
const loaded = async () => { try { return ((await (await fetch(`${endpoint}/api/ps`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: { name: string }[] }).models?.map(model => model.name).join(', ') || 'none'; } catch { return 'no answer'; } };
const stored = async () => { try { return ((await (await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: { name: string }[] }).models?.map(model => model.name).sort().join(', ') || 'none'; } catch { return 'no answer'; } };
// the editor leaves a comma behind the last setting it writes
const settings = () => { try { return JSON.parse(fs.readFileSync(path.join(ud, 'User', 'settings.json'), 'utf8').replace(/,(?<end>\s*\})/g, '$<end>')) as Record<string, unknown>; } catch { return { unreadable: true }; } };

/** Starts the editor on the store as it is, with no model set, and hands what there is to look at to `run`. */
async function inEditor(run: (editor: { suggest(ms: number): Promise<string>; notification(): Promise<string>; waitNotification(wanted: RegExp, ms: number): Promise<string>; click(button: string): Promise<void>; view(): Promise<{ hint: string; models: string[] }>; isReady(ms: number): Promise<boolean> }) => Promise<void>): Promise<void> {
	fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(ws, { recursive: true });
	fs.writeFileSync(path.join(ws, 'a.ts'), 'export interface Item { name: string; price: number; qty: number; }\n\nexport function total(items: Item[]): number {\n    return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n\n');
	fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
	fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ ...getIsolatedClaudeRecord(), 'changeReview.enabled': false, 'editor.formatOnSave': false }));
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', VS_KOT_TAB_COMPLETION_HOME: home, VS_KOT_TAB_COMPLETION_PORT: String(ISOLATED_PORT) }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	endEditor = () => app.process().kill();
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
		const status = () => page.evaluate(() => [...document.querySelectorAll('.statusbar-item')].filter(s => /^Tab\b/.test(s.textContent.trim())).map(s => s.querySelector('.codicon')?.className.replace(/.*codicon-/, '') || '').join(' '));
		const isReady = async (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (/zap/.test(await status())) { return true; } await sleep(250); } return false; };
		const ghost = () => page.evaluate(() => [...document.querySelectorAll('[class*="ghost-text"]')].map(e => e.textContent).join('').trim());
		const notification = () => page.evaluate(() => [...document.querySelectorAll('.notification-toast')].map(n => `${n.querySelector('.notification-list-item-message')?.textContent ?? ''} [${[...n.querySelectorAll('.monaco-button')].map(b => b.textContent).join(' | ')}]`).join(' // '));
		let line = 1; let isOpen = false;
		await run({
			isReady,
			// types the start of a function and waits for what is suggested for its body
			suggest: async ms => {
				if (!isOpen) { await page.keyboard.press('Meta+p'); await sleep(500); await page.keyboard.type('a.ts', { delay: 5 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(2000); isOpen = true; }
				await page.keyboard.press('Escape'); await page.keyboard.press('Meta+1'); await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.press('Enter');
				await page.keyboard.type(`export function names${line++}(items: Item[]): string[] {`, { delay: 20 }); await page.keyboard.press('Enter');
				const t = Date.now(); let g = ''; while (Date.now() - t < ms) { g = await ghost(); if (g) { break; } await sleep(50); }
				return g.replace(/\s+/g, ' ').slice(0, 60);
			},
			waitNotification: async (wanted, ms) => { const t = Date.now(); let text = ''; while (Date.now() - t < ms) { text = await notification(); if (wanted.test(text)) { break; } await sleep(200); } return text; },
			notification,
			// opens the Tab Completion view in the side bar and its list of models
			view: async () => {
				await page.keyboard.press('Escape');
				await page.locator('.activitybar .action-item .action-label[aria-label^="Tab Completion"]').first().click(); await sleep(1500);
				const hint = await page.evaluate(() => document.querySelector('.tab-completion-hint')?.textContent ?? '');
				await page.locator('.tab-completion-select .monaco-select-box').first().click(); await sleep(700);
				const models = await page.evaluate(() => [...document.querySelectorAll('.monaco-select-box-dropdown-container .monaco-list-row')].map(row => ['.option-text', '.option-detail', '.option-decorator-right'].map(part => row.querySelector(part)?.textContent?.trim() ?? '').filter(Boolean).join(' · ')));
				await page.keyboard.press('Escape'); await sleep(300);
				return { hint, models };
			},
			click: async button => { await page.locator('.notification-toast .monaco-button', { hasText: button }).first().click(); }
		});
	} catch (e) { check('the run finished', false, String(e instanceof Error ? e.message : e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	endEditor = () => { };
}

const cases: (() => Promise<void>)[] = [
	// 1. A Mac that has both models, as one that is set up now gets the small one
	async () => {
		await makeStore(SMALL, LARGE);
		await inEditor(async editor => {
			const ready = await editor.isReady(90000);
			const suggestion = await editor.suggest(20000);
			check('with no model set, the small model answers', ready && !!suggestion && await loaded() === SMALL, `in memory: ${await loaded()}; suggested: ${suggestion}`);
			check('nothing is asked where the default is there', !/Switch/.test(await editor.notification()), `notifications: ${await editor.notification() || 'none'}`);
			const view = await editor.view();
			check('the view offers both models, and says what each is good for', view.models.some(model => model.startsWith(`${SMALL} · Quick`)) && view.models.some(model => model.startsWith(`${LARGE} · More Exact, Slower`)) && /standard model/.test(view.hint), `${view.models.join(' | ')}; hint: ${view.hint}`);
		});
	},
	// 2. A Mac that was set up when the large model was the default: it has that one only, and is asked
	async () => {
		await makeStore(LARGE);
		await inEditor(async editor => {
			const ready = await editor.isReady(90000);
			const offer = await editor.waitNotification(/Keep Current Model/, 15000);
			check('set up with the large model only: it is ready, and the move to the default is offered with a way to stay', ready && /new standard model/.test(offer) && /Switch/.test(offer) && /Keep Current Model/.test(offer), offer.slice(0, 280) || 'no notification');

			// the parts of the small model are put into the store, so that asking for it downloads no more than their list
			addModel(SMALL, false);
			await editor.click('Switch');
			let isMoved = false; for (let i = 0; i < 240 && !isMoved; i++) { await sleep(500); isMoved = (await stored()).includes(SMALL) && await editor.isReady(300) && await loaded() === SMALL; }
			const afterwards = await editor.suggest(20000);
			check('Switch gets the default and uses it, and the model setting stays empty', isMoved && !!afterwards && await loaded() === SMALL && settings()['tabCompletion.model'] === undefined, `store: ${await stored()}; in memory: ${await loaded()}; suggested: ${afterwards}; setting: ${JSON.stringify(settings()['tabCompletion.model'])}`);
		});
	},
	// 3. The same Mac, and the choice to stay with the large model
	async () => {
		await makeStore(LARGE);
		await inEditor(async editor => {
			await editor.isReady(90000);
			await editor.waitNotification(/Keep Current Model/, 15000);
			await editor.click('Keep Current Model');
			for (let i = 0; i < 40 && settings()['tabCompletion.model'] === undefined; i++) { await sleep(250); }
			const ready = await editor.isReady(60000);
			const suggestion = await editor.suggest(30000);
			check('Keep Current Model writes the large model into the settings, and it goes on answering', settings()['tabCompletion.model'] === LARGE && ready && !!suggestion && await loaded() === LARGE, `setting: ${JSON.stringify(settings()['tabCompletion.model'])}; in memory: ${await loaded()}; suggested: ${suggestion}`);
		});
	},
	// 4. The same Mac. Nothing is answered, and the default arrives without this window having asked for it: another window fetched it
	async () => {
		await makeStore(LARGE);
		await inEditor(async editor => {
			await editor.isReady(90000);
			const suggestion = await editor.suggest(30000);
			const before = await loaded();
			check('with the offer left unanswered, tab completion works on with the large model', !!suggestion && before === LARGE, `in memory: ${before}; suggested: ${suggestion}`);
			const view = await editor.view();
			check('the view offers the default there too, as not downloaded, and says which model is used meanwhile', view.models.some(model => model.startsWith(`${SMALL} · Quick`) && /Not Downloaded/.test(model)) && view.hint.includes(LARGE) && view.hint.includes(SMALL), `${view.models.join(' | ')}; hint: ${view.hint}`);
			addModel(SMALL);
			let isMoved = false; const started = Date.now();
			while (!isMoved && Date.now() - started < 100000) { await sleep(8000); await editor.suggest(4000); isMoved = await loaded() === SMALL; }
			check('the default arrives through another window: this one moves to it within two minutes', isMoved, isMoved ? `the small model answered after ${Math.round((Date.now() - started) / 1000)} s` : `still ${await loaded()}`);
		});
	}
];

(async () => {
	// node default-model.ts 3 runs the third case alone
	const chosen = process.argv.slice(2).map(Number);
	for (const [index, run] of cases.entries()) {
		if (chosen.length === 0 || chosen.includes(index + 1)) { await run(); }
	}

	stopIsolatedModelServer();
	// nothing of the downloaded models was touched: the store of the check only ever held links
	const real = cp.execSync(`ls "${path.join(realModelServerHome, library)}"`, { encoding: 'utf8' }).trim().split('\n').sort().join(', ');
	const weights = [SMALL, LARGE].map(name => {
		const list = JSON.parse(fs.readFileSync(path.join(realModelServerHome, library, name.split(':')[1]), 'utf8')) as { layers: { digest: string; size: number }[] };
		const largest = list.layers.reduce((most, layer) => layer.size > most.size ? layer : most);
		try { return fs.statSync(path.join(realModelServerHome, 'models', 'blobs', largest.digest.replace(':', '-'))).size === largest.size; } catch { return false; }
	});
	check('the downloaded models are as they were', real.includes('1.5b-base') && real.includes('7b-base') && weights.every(Boolean), `${real}; weights complete: ${weights.join(', ')}`);
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
