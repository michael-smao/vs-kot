/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: does the review know which changes Claude Code made? Connects a stand-in for the settings of Claude Code,
// plays the part of Claude Code by running the hooks the way it runs them, and looks at what the review marks.
// Neither the real settings of Claude Code nor the real record are touched: both are set to folders of this check.
//
//   node .vs-kot/release-check/claude-record.ts

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedModelServer, repo, scratch } from './isolated.ts';

const home = path.join(scratch, 'claude-record');
const ws = path.join(home, 'ws');
const settingsFile = path.join(home, 'claude', 'settings.json');
const record = path.join(home, 'record');
const root = path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: ws, encoding: 'utf8' }).trim();
const file = (name: string) => path.join(ws, 'src', name);
const read = (name: string) => fs.readFileSync(file(name), 'utf8');

// --- a small repository, and settings of Claude Code the way it writes them
fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, 'src'), { recursive: true }); fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
const A = `export interface Item {\n    name: string;\n    price: number;\n    qty: number;\n}\n\nexport function total(items: Item[]): number {\n    return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n\nexport function names(items: Item[]): string[] {\n    return items.map((item) => item.name);\n}\n`;
const B = `export function greet(name: string): string {\n    return "Hello " + name;\n}\n\nexport function bye(name: string): string {\n    return "Bye " + name;\n}\n`;
fs.writeFileSync(file('a.ts'), A); fs.writeFileSync(file('b.ts'), B);
git('init', '-q', '.'); git('add', '.'); git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init');
const settingsBefore = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }, undefined, 2) + '\n';
fs.writeFileSync(settingsFile, settingsBefore);

fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ 'changeReview.autoReveal': false, 'window.dialogStyle': 'custom', 'changeReview.claudeCode.settingsFile': settingsFile, 'changeReview.claudeCode.recordFolder': record }));
setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 300000).unref();
const results: boolean[] = []; const check = (name: string, ok: boolean, detail?: string) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/** Runs the hooks that the settings have for a tool, the way Claude Code runs a hook: through a shell, with what the tool did on standard input. */
function runHooks(toolName: string, toolInput: object, toolResponse: object): number {
	let count = 0;
	const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
	for (const group of settings.hooks?.PostToolUse ?? []) {
		if (!String(group.matcher).split('|').includes(toolName)) { continue; }
		for (const hook of group.hooks) {
			cp.execFileSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify({ session_id: 'check', cwd: ws, hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: toolInput, tool_response: toolResponse }), env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } });
			count++;
		}
	}
	return count;
}
const events = () => fs.existsSync(path.join(record, 'events')) ? fs.readdirSync(path.join(record, 'events')).filter(name => name.endsWith('.json')).length : 0;
const entries = () => fs.existsSync(path.join(record, 'files')) ? fs.readdirSync(path.join(record, 'files')).flatMap(folder => fs.readdirSync(path.join(record, 'files', folder))).length : 0;

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', ...getIsolatedModelServer() }; delete env.ELECTRON_RUN_AS_NODE;
	const app = await _electron.launch({ executablePath: path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [repo, ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--disable-extension=vs-kot.tab-completion', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await page.waitForTimeout(9000);
		const open = async (name: string) => { await page.keyboard.press('Meta+p'); await page.waitForTimeout(500); await page.keyboard.type(name, { delay: 5 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); };
		const settle = () => page.waitForTimeout(4000);
		// where each change in the active editor says it comes from, top to bottom: 'Claude', or '-' for a change that says nothing
		const origins = () => page.evaluate(() => [...(document.querySelector('.editor-group-container.active')?.querySelectorAll('.change-review-hunk-widget') ?? [])]
			.map(widget => ({ top: widget.getBoundingClientRect().top, origin: widget.querySelector('.change-review-origin')?.textContent || '-' }))
			.sort((a, b) => a.top - b.top).map(widget => widget.origin).join(' '));
		const bar = () => page.evaluate(() => (document.querySelector('.editor-group-container.active .change-review-bar-widget .change-review-label')?.textContent || '').trim());
		const offer = () => page.locator('.statusbar-item', { hasText: 'Connect Claude Code' }).count();
		const dialog = () => page.evaluate(() => (document.querySelector('.monaco-dialog-box')?.textContent || '').replace(/\s+/g, ' ').trim());
		const press = async (label: string) => { await page.locator('.monaco-dialog-box .monaco-button', { hasText: label }).first().click(); await page.waitForTimeout(2500); };

		// 1. not connected: the offer is there, and nothing was written anywhere
		check('while Claude Code is not connected, the status bar offers to connect it', await offer() === 1 && !fs.existsSync(record) && fs.readFileSync(settingsFile, 'utf8') === settingsBefore, `offers: ${await offer()}; record folder there: ${fs.existsSync(record)}`);

		// 2. connecting
		await page.locator('.statusbar-item', { hasText: 'Connect Claude Code' }).first().click(); await page.waitForTimeout(1500);
		const question = await dialog();
		check('the offer asks before it changes anything, and says which file it changes', /Connect Claude Code to the Change Review\?/.test(question) && question.includes('settings.json') && fs.readFileSync(settingsFile, 'utf8') === settingsBefore, question.slice(0, 160));
		await press('Connect'); await page.waitForTimeout(1500);
		const connected = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		check('connecting adds two hooks and keeps the rest of the settings', connected.hooks.PostToolUse.length === 2 && connected.hooks.Stop.length === 1 && connected.permissions.allow[0] === 'Bash(ls:*)' && fs.existsSync(path.join(record, 'hook.sh')) && await offer() === 0,
			`hooks for: ${connected.hooks.PostToolUse.map((group: { matcher: string }) => group.matcher).join(' and ')}; offer still there: ${await offer()}`);

		// 3. Claude Code edits a file that another program has changed too
		fs.writeFileSync(file('a.ts'), A.replace('item.name);', 'item.name.trim());'));
		const oldString = '    return items.reduce((sum, item) => sum + item.price * item.qty, 0);';
		const newString = '    const net = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n    return net * 1.19;';
		fs.writeFileSync(file('a.ts'), read('a.ts').replace(oldString, newString));
		const hooksRun = runHooks('Edit', { file_path: file('a.ts'), old_string: oldString, new_string: newString, replace_all: false }, { filePath: file('a.ts'), oldString, newString });
		await settle(); await open('a.ts'); await settle();
		check('of two changes in a file, the one Claude Code made is marked and the other is not', hooksRun === 1 && await origins() === 'Claude -', `hooks run: ${hooksRun}; changes top to bottom: ${await origins()}`);

		// 4. a formatter indents the lines of Claude Code anew
		fs.writeFileSync(file('a.ts'), read('a.ts').replace('    const net', '\tconst net').replace('    return net', '\treturn net'));
		await settle();
		check('lines of Claude Code that were indented anew are still marked', await origins() === 'Claude -', `changes top to bottom: ${await origins()}`);

		// 5. a file that only another program changed
		fs.writeFileSync(file('b.ts'), B.replace('"Hello " + name', '`Hello, ${name}!`'));
		await settle(); await open('b.ts'); await settle();
		check('a change that Claude Code did not make is not marked', await origins() === '-', `changes: ${await origins()}`);

		// 6. a shell command of Claude Code changes that file, while it is open
		const eventsBefore = events();
		runHooks('Bash', { command: 'ls' }, { stdout: 'a.ts\nb.ts', stderr: '', interrupted: false });
		const eventsAfterNoChange = events();
		fs.writeFileSync(file('b.ts'), read('b.ts').replace('"Bye " + name', '"Goodbye " + name'));
		runHooks('Bash', { command: `sed -i '' 's/Bye/Goodbye/' src/b.ts` }, { stdout: '', stderr: '', interrupted: false, bashEditDiff: { files: [{ filePath: file('b.ts'), hunks: [{ oldStart: 6, oldLines: 1, newStart: 6, newLines: 1, lines: ['-    return "Bye " + name;', '+    return "Goodbye " + name;'] }] }], moreFiles: 0, changedFiles: [file('b.ts')] } });
		await settle();
		check('a change by a shell command of Claude Code is marked, and a command that changed nothing leaves nothing behind', eventsAfterNoChange === eventsBefore && await origins() === '- Claude', `events kept for "ls": ${eventsAfterNoChange - eventsBefore}; changes top to bottom: ${await origins()}`);

		// 7. approving a marked change
		await page.locator('.editor-group-container.active .change-review-hunk-widget', { hasText: 'Claude' }).locator('.monaco-button', { hasText: 'Approve' }).click(); await page.waitForTimeout(4000);
		const staged = git('show', ':src/b.ts');
		check('a marked change is approved like any other', staged.includes('"Goodbye " + name') && staged.includes('"Hello " + name') && await origins() === '-', `staged the change of Claude Code: ${staged.includes('Goodbye')}; staged the other one too: ${!staged.includes('"Hello " + name')}; left: ${await origins()}`);

		// 8. new files
		fs.writeFileSync(file('made.ts'), 'export const made = true;\n');
		runHooks('Write', { file_path: file('made.ts'), content: 'export const made = true;\n' }, { type: 'create', filePath: file('made.ts'), content: 'export const made = true;\n', structuredPatch: [], originalFile: null });
		fs.writeFileSync(file('theirs.ts'), 'export const theirs = true;\n');
		await settle(); await open('made.ts'); await settle(); const madeBar = await bar();
		await open('theirs.ts'); await settle(); const theirsBar = await bar();
		check('a new file that Claude Code wrote says so, and one that another program wrote does not', madeBar === 'New File · Claude' && theirsBar === 'New File', `made.ts: "${madeBar}"; theirs.ts: "${theirsBar}"`);

		// 9. what is kept
		const stored = fs.readdirSync(path.join(record, 'files')).flatMap(folder => fs.readdirSync(path.join(record, 'files', folder)).map(name => fs.readFileSync(path.join(record, 'files', folder, name), 'utf8'))).join('\n');
		check('the record holds one entry per changed file, and no line of any file', entries() === 3 && !/net \* 1\.19|Goodbye|made = true/.test(stored), `entries: ${entries()}; an entry: ${stored.split('\n')[0].slice(0, 110)}`);

		// 10. the connection says that it hears from Claude Code, and disconnecting gives the settings back
		await page.keyboard.press('Meta+Shift+p'); await page.waitForTimeout(600); await page.keyboard.type('Claude Code Connection', { delay: 5 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(2000);
		const state = await dialog();
		check('the connection says when it last heard from Claude Code, and from where', /Claude Code Is Connected/.test(state) && /Last heard from Claude Code .*desktop app/.test(state), state.slice(0, 170));
		await press('Disconnect'); await page.waitForTimeout(1500);
		check('disconnecting gives the settings of Claude Code back as they were', fs.readFileSync(settingsFile, 'utf8') === settingsBefore && await offer() === 1, `settings as before: ${fs.readFileSync(settingsFile, 'utf8') === settingsBefore}; offer back: ${await offer()}`);
		await open('made.ts'); await settle();
		check('what is on record stays after disconnecting', await bar() === 'New File · Claude', `made.ts: "${await bar()}"`);
	} catch (e) { check('the run finished', false, String(e && (e as Error).message || e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	try { app.process().kill('SIGKILL'); } catch { /* gone already */ }
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
