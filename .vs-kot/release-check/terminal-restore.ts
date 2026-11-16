/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: do the terminals of a folder come back when it is opened again, with their number, layout, folder and
// output? Both terminals of the check are typed in: one that never was is not kept, upstream's rule, which the README
// names. After the window was only closed (Close Window, which leaves the app running on macOS and shuts the window
// down for CLOSE: upstream's default restores nothing then) and after the app was quit. Each case has a folder and a
// profile of its own, which both of its starts use. Drives the source build, without tab completion. The terminals
// are those of the default profile, a zsh login shell; each command the check types first unsets HISTFILE, so that
// it stays out of the developer's shell history.
//
//   node .vs-kot/release-check/terminal-restore.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { getIsolatedClaudeRecord, repo, scratch } from './isolated.ts';

const base = path.join(scratch, 'terminal-restore');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
/** What the check echoes in the second terminal: the command says `$((6*7))`, only its output says 42. */
const MARKER = 'restore-marker-42';
/** What it echoes in the first one, the same way. */
const FIRST_MARKER = 'first-terminal-6';

/** The shutdown reasons of the workbench, as its lifecycle log names them. */
const SHUTDOWN_REASONS: Record<string, string> = { '1': 'CLOSE', '2': 'QUIT', '3': 'RELOAD', '4': 'LOAD' };

setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 420000).unref();
const results: boolean[] = []; const check = (name: string, ok: boolean, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

fs.rmSync(base, { recursive: true, force: true });

/**
 * Starts the source build on a folder.
 * @param trace whether to log at trace level, which shows the reason the window shut down for
 */
async function launch(folder: string, ud: string, trace: boolean): Promise<{ app: ElectronApplication; page: Page }> {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', VS_KOT_TAB_COMPLETION_HOME: path.join(base, 'tab-completion'), VS_KOT_TAB_COMPLETION_PORT: '11680' }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, folder, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(path.dirname(ud), 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain', ...(trace ? ['--log=trace'] : [])], env, timeout: 120000 });
	const page = await app.firstWindow({ timeout: 120000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await sleep(9000);
	return { app, page };
}

/** Runs a command from the Command Palette: the entry whose label is exactly the given one. */
async function runCommand(page: Page, label: string): Promise<void> {
	await page.keyboard.press('Meta+Shift+p'); await sleep(600); await page.keyboard.type(label, { delay: 5 }); await sleep(900);
	const row = page.locator('.quick-input-list .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
	if (await row.count()) { await row.click(); } else { await page.keyboard.press('Enter'); }
}

async function waitFor<T>(probe: () => Promise<T>, ok: (value: T) => boolean, ms: number): Promise<T> {
	let value = await probe();
	for (const end = Date.now() + ms; !ok(value) && Date.now() < end; value = await probe()) { await sleep(300); }
	return value;
}

/** The terminals of the window: how many, how many are on screen, the tabs, and the lines each one shows. */
function terminals(page: Page) {
	return page.evaluate(() => {
		const wrappers = [...document.querySelectorAll('.terminal-wrapper')];
		const visible = wrappers.filter(wrapper => wrapper.classList.contains('active') && (wrapper as HTMLElement).offsetWidth > 0 && (wrapper as HTMLElement).offsetHeight > 0);
		return {
			count: wrappers.length,
			visible: visible.length,
			tabs: [...document.querySelectorAll('.terminal-tabs-entry')].filter(entry => (entry as HTMLElement).offsetHeight > 0).length,
			focused: wrappers.findIndex(wrapper => !!wrapper.querySelector('.xterm.focus')),
			lines: wrappers.map(wrapper => [...wrapper.querySelectorAll('.xterm-rows > div')].map(row => (row.textContent || '').replace(/\u00a0/g, ' ').trimEnd()).filter(Boolean))
		};
	});
}
type Terminals = Awaited<ReturnType<typeof terminals>>;
const endsInPrompt = (lines: string[] | undefined) => !!lines?.length && /[%$#]$/.test(lines[lines.length - 1]);
const show = (lines: string[] | undefined) => JSON.stringify((lines || []).slice(-6));

/** Types a command into the focused terminal. */
async function type(page: Page, command: string): Promise<void> {
	await page.keyboard.type(`unset HISTFILE; ${command}`, { delay: 10 }); await page.keyboard.press('Enter');
}

/** The shutdown reasons of the windows that the logs of a profile know. */
function shutdownReasons(ud: string): string[] {
	const logs = path.join(ud, 'logs');
	const output = fs.existsSync(logs) ? cp.spawnSync('grep', ['-rhoE', 'onBeforeUnload \\(reason: [0-9]+\\)', logs], { encoding: 'utf8' }).stdout : '';
	return [...output.matchAll(/reason: (?<reason>\d+)/g)].map(match => SHUTDOWN_REASONS[match.groups!.reason] ?? match.groups!.reason);
}

/** What the profile kept for the next start: the terminals of the layout, and the terminals whose output was kept. */
function persisted(ud: string): string {
	const storage = path.join(ud, 'User', 'workspaceStorage');
	const databases = fs.existsSync(storage) ? fs.readdirSync(storage).map(name => path.join(storage, name, 'state.vscdb')).filter(file => fs.existsSync(file)) : [];
	const value = (key: string) => databases.map(database => cp.spawnSync('sqlite3', [database, `SELECT value FROM ItemTable WHERE key = '${key}'`], { encoding: 'utf8' }).stdout.trim()).find(Boolean);
	try {
		const layout = value('terminal.integrated.layoutInfo'); const buffers = value('terminal.integrated.bufferState');
		const layoutTerminals = layout ? (JSON.parse(layout).tabs as { terminals: unknown[] }[]).reduce((sum, tab) => sum + tab.terminals.length, 0) : 0;
		const bufferTerminals = buffers ? (JSON.parse(buffers).state as unknown[]).length : 0;
		return `the profile kept a layout of ${layoutTerminals} terminal(s) and the output of ${bufferTerminals}`;
	} catch (e) {
		return `the profile's terminal state could not be read: ${e instanceof Error ? e.message : e}`;
	}
}

/**
 * One case: two terminals, each with a marker, the second one split off the first and in src; the window closed or
 * the app quit; the folder opened again.
 */
async function runCase(kind: 'close' | 'quit'): Promise<void> {
	const title = kind === 'close' ? 'after Close Window' : 'after quitting';
	const dir = path.join(base, kind); const ws = path.join(dir, 'ws'); const ud = path.join(dir, 'ud');
	const cwdFile = path.join(dir, 'cwd.txt');
	fs.mkdirSync(path.join(ws, 'src'), { recursive: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
	fs.writeFileSync(path.join(ws, 'src', 'app.ts'), 'export const app = 1;\n');
	cp.execFileSync('git', ['init', '-q', '.'], { cwd: ws }); cp.execFileSync('git', ['add', '.'], { cwd: ws }); cp.execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'], { cwd: ws });
	fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
		...getIsolatedClaudeRecord(),
		'changeReview.autoReveal': false, 'tabCompletion.enabled': false, 'editor.minimap.enabled': false,
		// the DOM renderer, so that the check can read what a terminal shows
		'terminal.integrated.gpuAcceleration': 'off'
	}));

	// --- first start: two terminals side by side, each typed in, the second one in src
	let { app, page } = await launch(ws, ud, true);
	try {
		await runCommand(page, 'Terminal: Create New Terminal');
		await waitFor(() => terminals(page), t => t.count === 1 && endsInPrompt(t.lines[0]), 30000);
		await sleep(500);
		await type(page, `echo "first-terminal-$((2*3))"`);
		await waitFor(() => terminals(page), t => t.lines[0]?.includes(FIRST_MARKER) && endsInPrompt(t.lines[0]), 15000);
		await runCommand(page, 'Terminal: Split Terminal');
		await waitFor(() => terminals(page), t => t.count === 2 && t.focused === 1 && endsInPrompt(t.lines[1]), 30000);
		await sleep(500);
		await type(page, `cd src; echo "restore-marker-$((6*7))"`);
		const t = await waitFor(() => terminals(page), t => t.lines[1]?.includes(MARKER) && endsInPrompt(t.lines[1]), 15000);
		check(`${title}: the first start has two terminals side by side, each with its marker, the second one in src`, t.count === 2 && t.visible === 2 && t.lines[0].includes(FIRST_MARKER) && t.lines[1].includes(MARKER), `${t.count} terminal(s), ${t.visible} on screen, ${t.tabs} tab(s); the first one shows ${show(t.lines[0])}; the second one ${show(t.lines[1])}`);
		await sleep(1500);
	} catch (e) {
		check(`${title}: the first start finished`, false, String(e instanceof Error ? e.message : e).slice(0, 300));
	}

	if (kind === 'close') {
		// only the window: the app stays running, as on macOS, and is quit afterwards
		const closed = page.waitForEvent('close', { timeout: 30000 }).then(() => true, () => false);
		await runCommand(page, 'Close Window');
		const windowClosed = await closed; await sleep(2000);
		const running = app.process().exitCode === null && app.process().signalCode === null;
		check('Close Window closes the window and leaves the app running', windowClosed && running && app.windows().length === 0, `window closed: ${windowClosed}; app running: ${running}; windows left: ${app.windows().length}`);
	}
	await Promise.race([app.close().catch(() => undefined), sleep(30000)]);
	const reasons = shutdownReasons(ud);
	const expected = kind === 'close' ? 'CLOSE' : 'QUIT';
	check(`${title}: the window shut down for ${expected}`, reasons.length > 0 && reasons.every(reason => reason === expected), `reasons in the log: ${reasons.join(', ') || 'none'}; ${persisted(ud)}`);

	// --- second start: the same folder, the same profile
	({ app, page } = await launch(ws, ud, false));
	try {
		// the panel comes back as it was; only if it does not show the terminals, they are brought up
		const onScreen = (t: Terminals) => t.visible > 0;
		let t = await waitFor(() => terminals(page), onScreen, 5000);
		const panelWasVisible = onScreen(t);
		if (!panelWasVisible) {
			await runCommand(page, 'View: Toggle Terminal');
		}
		t = await waitFor(() => terminals(page), t => t.count >= 2 && t.lines.every(lines => lines.some(line => line.includes('History restored')) && endsInPrompt(lines)), 30000);
		check(`${title}: both terminals come back, side by side`, t.count === 2 && t.visible === 2 && (t.tabs === 0 || t.tabs === 2), `${t.count} terminal(s), ${t.visible} on screen, ${t.tabs} tab(s); the panel ${panelWasVisible ? 'came back by itself' : 'was opened with View: Toggle Terminal'}`);
		const restored = (lines: string[] | undefined) => !!lines?.some(line => line.includes('History restored'));
		const first = t.lines.findIndex(lines => lines.includes(FIRST_MARKER));
		const marked = t.lines.findIndex(lines => lines.includes(MARKER));
		check(`${title}: the first terminal shows its output from before, and "History restored"`, first !== -1 && first !== marked && restored(t.lines[first]), first === -1 ? `no terminal shows ${FIRST_MARKER}: ${t.lines.map(show).join(' | ')}` : `terminal ${first + 1} shows ${show(t.lines[first])}`);
		check(`${title}: the second terminal shows its output from before, and "History restored"`, marked !== -1 && restored(t.lines[marked]), marked === -1 ? `no terminal shows ${MARKER}: ${t.lines.map(show).join(' | ')}` : `terminal ${marked + 1} shows ${show(t.lines[marked])}`);

		// the folder of the revived shell: where the marker was echoed, src
		fs.rmSync(cwdFile, { force: true });
		if (marked !== -1) {
			await page.locator('.terminal-wrapper').nth(marked).locator('.xterm-screen').click();
			await waitFor(() => terminals(page), t => t.focused === marked, 5000);
			await type(page, `pwd > ${cwdFile}`);
			await waitFor(async () => read(cwdFile), text => !!text?.endsWith('\n'), 15000);
		}
		const cwd = (read(cwdFile) || '').trim();
		check(`${title}: the revived shell with the marker is in src`, !!cwd && fs.realpathSync(cwd) === fs.realpathSync(path.join(ws, 'src')), `pwd: "${cwd}"`);
	} catch (e) {
		check(`${title}: the second start finished`, false, String(e instanceof Error ? e.message : e).slice(0, 300));
	} finally {
		await Promise.race([app.close().catch(() => undefined), sleep(30000)]);
	}
}

(async () => {
	await runCase('close');
	await runCase('quit');
	console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
	process.exit(results.every(Boolean) ? 0 : 1);
})();
