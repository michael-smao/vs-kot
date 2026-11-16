/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: does a window find the Python environment of its folder, ask once, and activate it in a new terminal, in
// front of what `pyenv init` in ~/.zshrc puts on the PATH? Does Select Python Environment list the environments one
// level below as well, and go to another one? When that one is deleted, does the status bar say it is missing, does a
// new terminal start without a failed activation, and is it used again once it is made anew? Does Ruff lint with it,
// without a notification of its own on the screen? And is nothing written into the project?
// Drives the source build, with a profile of its own and without tab completion. The terminals are those of the
// default profile, a zsh login shell that reads the developer's own startup files; each command the check types
// first unsets HISTFILE, so that it stays out of the developer's shell history.
//
//   node .vs-kot/release-check/python-env.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedClaudeRecord, repo, scratch } from './isolated.ts';

const base = path.join(scratch, 'python-env');
const ws = path.join(base, 'ws'); const ud = path.join(base, 'ud');
const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: ws, encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
const ruffExtension = path.join(repo, '.build', 'builtInExtensions', 'charliermarsh.ruff');
/** The hint that Ruff gives on its first start in a profile, when neither of Microsoft's Python extensions is there. */
const RUFF_HINT = 'No Python environment extension is available';

const python3 = cp.spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (python3.status !== 0) {
	console.log(`SKIPPED  there is no python3 on the PATH to make a virtual environment with${python3.error ? ': ' + python3.error.message : ''}`);
	process.exit(0);
}

// --- a small project, committed, whose .gitignore leaves out the environments
fs.rmSync(base, { recursive: true, force: true }); fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ws, '.gitignore'), '.venv/\napi/.venv/\n');
fs.writeFileSync(path.join(ws, 'main.py'), 'import os\n\nprint("hello")\n');
git('init', '-q', '.'); git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init');
const makeEnvironment = (relativePath: string) => {
	cp.execFileSync('python3', ['-m', 'venv', relativePath], { cwd: ws, stdio: 'pipe' });
	return (/^\s*version\s*=\s*(?<version>\S+)/m.exec(fs.readFileSync(path.join(ws, relativePath, 'pyvenv.cfg'), 'utf8'))?.groups?.version) ?? '';
};
const venv = path.join(ws, '.venv'); const apiVenv = path.join(ws, 'api', '.venv');
const version = makeEnvironment('.venv');
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
	...getIsolatedClaudeRecord(),
	'changeReview.autoReveal': false, 'tabCompletion.enabled': false, 'editor.minimap.enabled': false,
	// the DOM renderer, so that the check can read what a terminal shows
	'terminal.integrated.gpuAcceleration': 'off'
}));

setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 360000).unref();
const results: boolean[] = []; const check = (name: string, ok: boolean, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/** A notification as the window showed it. */
interface IShownNotification { readonly message: string; readonly source: string }
/** Where the page keeps every toast it has shown, see {@link watchToasts}. */
interface IToastRecord { vsKotToasts?: IShownNotification[] }

/** Notes every toast the window shows from now on, however briefly. */
function watchToasts(): void {
	const record = globalThis as unknown as IToastRecord;
	const shown = record.vsKotToasts = [] as IShownNotification[];
	const seen = new Set<string>();
	const scan = () => {
		for (const toast of document.querySelectorAll<HTMLElement>('.notification-toast')) {
			const message = (toast.querySelector('.notification-list-item-message')?.textContent || '').trim();
			const source = (toast.querySelector('.notification-list-item-source')?.textContent || '').trim();
			if (message && toast.offsetHeight > 0 && !seen.has(`${source}|${message}`)) {
				seen.add(`${source}|${message}`);
				shown.push({ message, source });
			}
		}
	};
	new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
	scan();
}

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', VS_KOT_TAB_COMPLETION_HOME: path.join(base, 'tab-completion'), VS_KOT_TAB_COMPLETION_PORT: '11679' }; delete env.ELECTRON_RUN_AS_NODE;
	// an environment that is active where the check is started must not reach the terminals of the window
	delete env.VIRTUAL_ENV;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(base, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	const errors: string[] = [];
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		page.on('console', m => { if (m.type() === 'error' && /Python environment|vsKotPython|Cannot read|is not a function/i.test(m.text())) { errors.push(m.text().slice(0, 200)); } });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
		await page.evaluate(watchToasts);
		const startedAt = Date.now();

		/** Runs a command from the Command Palette: the entry whose label is exactly the given one. */
		const runCommand = async (label: string) => {
			await page.keyboard.press('Meta+Shift+p'); await sleep(600); await page.keyboard.type(label, { delay: 5 }); await sleep(900);
			const row = page.locator('.quick-input-list .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
			if (await row.count()) { await row.click(); } else { await page.keyboard.press('Enter'); }
		};
		/** The status bar entry of the environment, with its icon written as `$(name)`. */
		const statusText = () => page.evaluate(() => {
			const entry = document.getElementById('status.vsKotPythonEnvironment');
			const icon = /(?:^|\s)codicon-(?<name>[\w-]+)/.exec(entry?.querySelector('.codicon')?.className || '')?.groups?.name;
			return entry ? `${icon ? `$(${icon}) ` : ''}${(entry.textContent || '').trim()}` : '';
		});
		const waitFor = async <T>(probe: () => Promise<T>, ok: (value: T) => boolean, ms: number): Promise<T> => {
			let value = await probe();
			for (const end = Date.now() + ms; !ok(value) && Date.now() < end; value = await probe()) { await sleep(300); }
			return value;
		};
		/** What the focused terminal shows. */
		const focusedTerminal = () => page.evaluate(() => [...document.querySelectorAll('.terminal-wrapper .xterm.focus .xterm-rows > div')].map(row => (row.textContent || '').replace(/ /g, ' ').trimEnd()).filter(Boolean).join('\n'));
		/** Opens a new terminal, waits for its prompt and has it write where its Python comes from. */
		const pythonOfNewTerminal = async (out: string) => {
			fs.rmSync(out, { force: true });
			await runCommand('Terminal: Create New Terminal');
			const prompt = await waitFor(focusedTerminal, text => /[%$#]$/.test(text), 30000);
			await sleep(1000);
			await page.keyboard.type(`unset HISTFILE; echo "$VIRTUAL_ENV|$(command -v python)|$PATH" > ${out}`, { delay: 10 }); await page.keyboard.press('Enter');
			await waitFor(async () => read(out), text => !!text && text.endsWith('\n'), 20000);
			const [virtualEnv, python, pathVariable = ''] = (read(out) || '').trim().split('|');
			// where the shims of pyenv are, if ~/.zshrc runs `pyenv init`: they have to come after the environment
			const entries = pathVariable.split(':'); const shims = entries.findIndex(entry => entry.endsWith('/.pyenv/shims'));
			const pyenv = shims === -1 ? 'no pyenv shims on the PATH' : `pyenv's shims on the PATH at ${shims + 1}, the environment at ${entries.indexOf(path.dirname(python)) + 1}`;
			return { virtualEnv, python, pyenv, prompt: prompt.split('\n').pop() || '', text: await focusedTerminal() };
		};
		const isActivated = (terminal: Awaited<ReturnType<typeof pythonOfNewTerminal>>, environment: string) => terminal.virtualEnv === environment && terminal.python === path.join(environment, 'bin', 'python');
		const describe = (terminal: Awaited<ReturnType<typeof pythonOfNewTerminal>>) => `VIRTUAL_ENV "${terminal.virtualEnv}", python "${terminal.python}", ${terminal.pyenv}, prompt "${terminal.prompt}"`;

		// 1. the window asks once whether to use the environment it found, with Don't Show Again next to Activate
		const toast = page.locator('.notification-toast', { hasText: 'This folder has a Python environment' }).first();
		await toast.waitFor({ state: 'visible', timeout: 60000 }).catch(() => undefined);
		const message = await toast.isVisible() ? (await toast.locator('.notification-list-item-message').first().textContent() || '').trim() : '';
		const buttons = message ? (await toast.locator('.monaco-button').allTextContents()).map(text => text.trim()).filter(Boolean) : [];
		check('the window asks whether to activate the environment .venv, with the buttons Activate and Don\'t Show Again', message.includes('This folder has a Python environment in .venv') && buttons.includes('Activate') && buttons.includes('Don\'t Show Again'), message ? `"${message}" after ${Math.round((Date.now() - startedAt) / 1000)} s, buttons ${JSON.stringify(buttons)}` : 'no notification "This folder has a Python environment" within 60 s');
		if (message) {
			await toast.locator('.monaco-button', { hasText: /^Activate$/ }).first().click();
		}

		// 2. the status bar names it
		let status = await waitFor(statusText, text => text.includes('.venv'), 10000);
		check('the status bar shows the active environment and its Python version', status === `$(python) .venv (${version})`, `"${status}"`);

		// 3. a new terminal of the default profile has it activated, in front of pyenv
		let terminal = await pythonOfNewTerminal(path.join(base, 'out.txt'));
		check('a new terminal has .venv activated: VIRTUAL_ENV and the python on the PATH are those of .venv', isActivated(terminal, venv), describe(terminal));
		check('nothing was written into the project', git('status', '--porcelain') === '', `git status: "${git('status', '--porcelain')}"`);

		// 4. a second environment one level below, and Select Python Environment
		const apiVersion = makeEnvironment(path.join('api', '.venv'));
		await sleep(3000);
		await runCommand('Select Python Environment...');
		await page.waitForSelector('.quick-input-list .monaco-list-row', { timeout: 10000 }).catch(() => undefined); await sleep(800);
		const rows = await page.evaluate(() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(row => (row.querySelector('.label-name')?.textContent || '').trim()));
		check('Select Python Environment lists .venv, api/.venv and No Environment', rows.includes('.venv') && rows.includes('api/.venv') && rows.includes('No Environment'), JSON.stringify(rows));
		await page.locator('.quick-input-list .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: /^api\/\.venv$/ }) }).first().click({ timeout: 5000 }).catch(() => undefined);
		const apiStatus = `$(python) api/.venv (${apiVersion})`;
		status = await waitFor(statusText, text => text.includes('api/.venv'), 10000);
		check('the status bar shows the chosen environment', status === apiStatus, `"${status}"`);
		terminal = await pythonOfNewTerminal(path.join(base, 'out2.txt'));
		check('a new terminal has api/.venv activated', isActivated(terminal, apiVenv), describe(terminal));

		// 5. the chosen environment is deleted: a terminal opened right away still has its activation, and must not fail
		fs.rmSync(apiVenv, { recursive: true, force: true });
		const deletedAt = Date.now();
		const statusAtOpening = await statusText();
		terminal = await pythonOfNewTerminal(path.join(base, 'out3.txt'));
		check('a terminal opened right after the environment was deleted starts without a failed activation', !/activation failed/i.test(terminal.text) && !terminal.virtualEnv, `the status bar said "${statusAtOpening}" when it was opened; VIRTUAL_ENV "${terminal.virtualEnv}"; it shows ${JSON.stringify(terminal.text.split('\n').slice(-4))}`);
		status = await waitFor(statusText, text => text.includes('Python Environment Missing'), Math.max(0, 15000 - (Date.now() - deletedAt)));
		check('within 15 s the status bar says that the environment is missing', status === '$(warning) Python Environment Missing', `"${status}" ${Math.round((Date.now() - deletedAt) / 1000)} s after the environment was deleted`);
		terminal = await pythonOfNewTerminal(path.join(base, 'out4.txt'));
		check('a terminal opened while it is missing starts without a failed activation', !/activation failed/i.test(terminal.text) && !terminal.virtualEnv, `VIRTUAL_ENV "${terminal.virtualEnv}"; it shows ${JSON.stringify(terminal.text.split('\n').slice(-4))}`);

		// 6. made anew: it is used again
		makeEnvironment(path.join('api', '.venv'));
		const madeAt = Date.now();
		status = await waitFor(statusText, text => text === apiStatus, 30000);
		check('within 30 s of being made anew the environment is back in the status bar', status === apiStatus, `"${status}" ${Math.round((Date.now() - madeAt) / 1000)} s after it was made`);
		terminal = await pythonOfNewTerminal(path.join(base, 'out5.txt'));
		check('and a new terminal has it activated again', isActivated(terminal, apiVenv) && !/activation failed/i.test(terminal.text), describe(terminal));

		// 7. Ruff lints main.py, with the interpreter of the environment
		if (fs.existsSync(ruffExtension)) {
			await page.keyboard.press('Meta+p'); await sleep(500); await page.keyboard.type('main.py', { delay: 5 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(1500);
			await runCommand('View: Focus on Problems View');
			const problems = () => page.evaluate(() => [...document.querySelectorAll('.markers-panel .monaco-list-row')].map(row => (row.getAttribute('aria-label') || row.textContent || '').replace(/\s+/g, ' ').trim()));
			const isUnusedImport = (problem: string) => /imported but unused.*Ruff/.test(problem);
			const ruffProblems = await waitFor(problems, list => list.some(isUnusedImport), 60000);
			const squiggles = await page.evaluate(() => document.querySelectorAll('.editor-group-container.active .squiggly-warning, .editor-group-container.active .squiggly-error').length);
			// what Ruff wrote to its log about the interpreter it was given
			const logs = path.join(ud, 'logs');
			const ruffLog = (fs.existsSync(logs) ? cp.spawnSync('grep', ['-rh', `'ruff.interpreter'`, logs], { encoding: 'utf8' }).stdout.trim().split('\n') : []).filter(Boolean);
			check('Ruff marks the unused import in main.py', ruffProblems.some(isUnusedImport) && squiggles > 0, `problems: ${JSON.stringify(ruffProblems)}; squiggles in the editor: ${squiggles}`);
			check('Ruff was given the python of the environment as its interpreter', ruffLog.some(line => line.includes(`'${path.join(venv, 'bin', 'python')}'`) || line.includes(`'${path.join(apiVenv, 'bin', 'python')}'`)), ruffLog.map(line => line.replace(/^\S+ \S+ /, '')).join(' | ').slice(0, 400) || 'nothing in its log about ruff.interpreter');

			// 8. Ruff showed nothing on the screen: its hint is in the notification center at most
			const toasts = await page.evaluate(() => (globalThis as unknown as IToastRecord).vsKotToasts ?? []);
			const ruffToasts = toasts.filter(shown => /ruff/i.test(shown.source) || shown.message.includes(RUFF_HINT));
			check('Ruff showed no notification on the screen during the whole run', ruffToasts.length === 0, `toasts that the window showed: ${JSON.stringify(toasts.map(shown => `${shown.message.slice(0, 70)} (${shown.source || 'no source'})`))}`);
			await runCommand('Notifications: Show Notifications'); await sleep(1000);
			const center = await page.evaluate(() => [...document.querySelectorAll('.notifications-center .notification-list-item')].map(item => `${(item.querySelector('.notification-list-item-message')?.textContent || '').trim().slice(0, 70)} (${(item.querySelector('.notification-list-item-source')?.textContent || '').trim()})`));
			console.log(`INFO  Ruff's hint ${center.some(item => item.includes(RUFF_HINT)) ? 'is' : 'is not'} in the notification center: ${JSON.stringify(center)}`);
			await runCommand('Notifications: Hide Notifications');
		} else {
			console.log(`INFO  Ruff is not in ${ruffExtension}: linting and its notifications are not checked`);
		}

		check('nothing was written into the project, also after the second environment and linting', git('status', '--porcelain') === '', `git status: "${git('status', '--porcelain')}"`);
		check('no errors from the Python environment in the console', errors.length === 0, errors.join(' | '));
	} catch (e) {
		check('the run finished', false, String(e instanceof Error ? e.message : e).slice(0, 300));
	} finally {
		await Promise.race([app.close().catch(() => undefined), sleep(15000)]);
	}
	console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
	process.exit(results.every(Boolean) ? 0 : 1);
})();
