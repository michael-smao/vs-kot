/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: does the review know which changes Claude Code made and which files it deleted, and does it keep under
// review what Claude Code staged or committed? Connects a stand-in for the settings of Claude Code, plays the part of Claude Code by
// running the hooks the way it runs them, and looks at what the review shows.
// Neither the real settings of Claude Code nor the real record are touched: both are set to folders of this check.
//
//   node .vs-kot/release-check/claude-record.ts                                                   (source build)
//   PACKAGED_APP=../VSCode-darwin-arm64/vs-kot.app node .vs-kot/release-check/claude-record.ts     (the app)
//
// The profile for the app's run is kept under .build/, like the one of check.ts.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';
import { getIsolatedModelServer, repo, scratch } from './isolated.ts';

const home = path.join(scratch, 'claude-record');
const ws = path.join(home, 'ws');
const settingsFile = path.join(home, 'claude', 'settings.json');
const record = path.join(home, 'record');
const packagedApp = process.env.PACKAGED_APP;
const root = packagedApp ? path.join(repo, '.build', 'pkgtest') : path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: ws, encoding: 'utf8' }).trim();
const file = (name: string) => path.join(ws, 'src', name);
const read = (name: string) => fs.readFileSync(file(name), 'utf8');

// --- a small repository, and settings of Claude Code the way it writes them
fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(path.join(ws, 'src'), { recursive: true }); fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
const A = `export interface Item {\n    name: string;\n    price: number;\n    qty: number;\n}\n\nexport function total(items: Item[]): number {\n    return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n\nexport function names(items: Item[]): string[] {\n    return items.map((item) => item.name);\n}\n`;
const B = `export function greet(name: string): string {\n    return "Hello " + name;\n}\n\nexport function bye(name: string): string {\n    return "Bye " + name;\n}\n`;
fs.writeFileSync(file('a.ts'), A); fs.writeFileSync(file('b.ts'), B);
// one file per check of what Claude Code staged or committed: each says hello and goodbye in its own words. No
// name is the end of another one: the files are opened by typing their name, and the first match is taken.
const greeting = (word: string) => `export function hello(name: string): string {\n    return "${word} hello " + name;\n}\n\nexport const version = 1;\n\nexport function bye(name: string): string {\n    return "${word} bye " + name;\n}\n`;
for (const name of ['staged', 'committed', 'outside', 'during', 'branch', 'gone', 'part', 'erased', 'dropped']) { fs.writeFileSync(file(`${name}.ts`), greeting(name)); }
const commit = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q'];
git('init', '-q', '.'); git('add', '.'); git(...commit, '-m', 'init');
// another branch, on which one file is not what it is here
git('checkout', '-q', '-b', 'other'); fs.writeFileSync(file('branch.ts'), greeting('branch').replace('version = 1', 'version = 2')); git(...commit, '-am', 'on the other branch'); git('checkout', '-q', '-');
const settingsBefore = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }, undefined, 2) + '\n';
fs.writeFileSync(settingsFile, settingsBefore);

fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ 'changeReview.autoReveal': false, 'window.dialogStyle': 'custom', 'changeReview.claudeCode.settingsFile': settingsFile, 'changeReview.claudeCode.recordFolder': record }));
setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 600000).unref();
const results: boolean[] = []; const check = (name: string, ok: boolean, detail?: string) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/** Runs the hooks that the settings have for a tool, the way Claude Code runs a hook: through a shell, with what the tool did on standard input. */
function runHooks(toolName: string, toolInput: object, toolResponse?: object, event = 'PostToolUse', toolUseId = 'toolu_check'): number {
	let count = 0;
	const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
	for (const group of settings.hooks?.[event] ?? []) {
		if (!String(group.matcher).split('|').includes(toolName)) { continue; }
		for (const hook of group.hooks) {
			// the folder is that of the session, as with Claude Code: not the repository, which the command names itself
			const output = cp.execFileSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify({ session_id: 'check', cwd: home, hook_event_name: event, tool_name: toolName, tool_input: toolInput, tool_response: toolResponse, tool_use_id: toolUseId }), env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } });
			if (event === 'PreToolUse' && output.length > 0) { throw new Error(`the hook before a shell command wrote ${output.length} bytes: Claude Code would take that as an answer`); }
			count++;
		}
	}
	return count;
}
let shellCommands = 0;
/**
 * A shell command of Claude Code in the repository: the hook before it, the command, and the hook after it. The
 * command starts with a `cd` into the repository, the way Claude Code writes it when its session is elsewhere.
 * @param during what happens while the command runs, in place of a command that takes that long
 */
async function claudeShell(command: string, during?: () => Promise<void>): Promise<boolean> {
	const id = `toolu_shell${++shellCommands}`;
	const toolInput = { command: `cd ${ws} && ${command}`, description: 'a command of the check' };
	runHooks('Bash', toolInput, undefined, 'PreToolUse', id);
	let failed = false;
	try { cp.execSync(toolInput.command, { stdio: 'pipe' }); } catch { failed = true; }
	await during?.();
	if (failed) { runHooks('Bash', toolInput, undefined, 'PostToolUseFailure', id); } else { runHooks('Bash', toolInput, { stdout: '', stderr: '', interrupted: false }, 'PostToolUse', id); }
	return !failed;
}
const asClaude = '-c user.name=claude -c user.email=claude@example.com';
/** The files that are held under review although their changes are staged, as the record has them. */
const held = () => fs.existsSync(path.join(record, 'held')) ? fs.readdirSync(path.join(record, 'held')).map(name => JSON.parse(fs.readFileSync(path.join(record, 'held', name), 'utf8'))).filter(hold => hold.released === undefined).map(hold => path.basename(hold.path)).sort().join(' ') : '';
const stagedFiles = () => git('diff', '--cached', '--name-only').split('\n').filter(Boolean).map(name => path.basename(name)).sort().join(' ');
const events = () => fs.existsSync(path.join(record, 'events')) ? fs.readdirSync(path.join(record, 'events')).filter(name => name.endsWith('.json')).length : 0;
/** The files of which the record says that a shell command of Claude Code took them away. */
const deletions = () => fs.existsSync(path.join(record, 'files')) ? fs.readdirSync(path.join(record, 'files')).flatMap(folder => fs.readdirSync(path.join(record, 'files', folder)).map(name => JSON.parse(fs.readFileSync(path.join(record, 'files', folder, name), 'utf8')))).filter(entry => entry.isDeletion).map(entry => `${path.basename(entry.path)} ${entry.added.length + entry.removed.length}`).sort().join(', ') : '';
const entries = () => fs.existsSync(path.join(record, 'files')) ? fs.readdirSync(path.join(record, 'files')).flatMap(folder => fs.readdirSync(path.join(record, 'files', folder))).length : 0;

(async () => {
	const env: Record<string, string | undefined> = { ...process.env, ...getIsolatedModelServer() }; delete env.ELECTRON_RUN_AS_NODE;
	if (packagedApp) { delete env.VSCODE_DEV; delete env.NODE_ENV; delete env.VSCODE_CLI; } else { Object.assign(env, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }); }
	const app = await _electron.launch({ executablePath: packagedApp ? path.join(packagedApp, 'Contents', 'MacOS', 'vs-kot') : path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [...(packagedApp ? [] : [repo]), ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--disable-extension=vs-kot.tab-completion', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain'], env, timeout: 120000 });
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await page.waitForTimeout(9000);
		const open = async (name: string) => { await page.keyboard.press('Meta+p'); await page.waitForTimeout(500); await page.keyboard.type(name, { delay: 5 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); };
		const settle = () => page.waitForTimeout(4000);
		// where each change in the active editor says it comes from, top to bottom: 'Claude', or '-' for a change that says nothing
		const origins = () => page.evaluate(() => [...(document.querySelector('.editor-group-container.active')?.querySelectorAll('.change-review-hunk-widget') ?? [])]
			.map(widget => ({ top: widget.getBoundingClientRect().top, origin: widget.querySelector('.change-review-origin')?.textContent || '-' }))
			.sort((a, b) => a.top - b.top).map(widget => widget.origin).join(' '));
		const activeTab = () => page.evaluate(() => (document.querySelector('.editor-group-container.active .tabs-container .tab.active')?.textContent || '').trim());
		const nextFile = async () => { await page.keyboard.press('Meta+Shift+p'); await page.waitForTimeout(600); await page.keyboard.type('Go to Next File with Changes', { delay: 5 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); };
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
		const hookCount = (settings: { hooks: Record<string, { hooks: unknown[] }[]> }) => Object.entries(settings.hooks).filter(([event]) => event !== 'Stop').map(([event, groups]) => `${event} ${groups.length}`).join(', ');
		check('connecting adds four hooks and keeps the rest of the settings', hookCount(connected) === 'PostToolUse 2, PreToolUse 1, PostToolUseFailure 1' && connected.hooks.Stop.length === 1 && connected.permissions.allow[0] === 'Bash(ls:*)' && fs.existsSync(path.join(record, 'hook.sh')) && await offer() === 0,
			`hooks: ${hookCount(connected)}; offer still there: ${await offer()}`);

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

		// --- what Claude Code staged or committed stays under review
		const approve = async () => { await page.locator('.editor-group-container.active .change-review-hunk-widget .monaco-button', { hasText: 'Approve' }).first().click(); await page.waitForTimeout(4000); };
		const toReview = async () => (await page.locator('.statusbar-item', { hasText: /to Review|Reviewed/ }).first().textContent() ?? '').trim();
		// Claude Code replaces whole lines here: what it reports is compared line by line
		const claudeEdits = (name: string, oldPart: string, newPart: string) => {
			const oldString = `    return ${oldPart};`, newString = `    return ${newPart};`;
			fs.writeFileSync(file(name), read(name).replace(oldString, newString));
			runHooks('Edit', { file_path: file(name), old_string: oldString, new_string: newString, replace_all: false }, { filePath: file(name), oldString, newString });
		};

		// 9b. Claude Code replaces a part of a line, and answers the way it does: with the lines of the file it changed
		const before = read('part.ts');
		fs.writeFileSync(file('part.ts'), before.replace('"part hello "', '"part hi "'));
		runHooks('Edit', { file_path: file('part.ts'), old_string: '"part hello "', new_string: '"part hi "', replace_all: false }, {
			filePath: file('part.ts'), oldString: '"part hello "', newString: '"part hi "', originalFile: before, userModified: false, replaceAll: false,
			structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' export function hello(name: string): string {', '-    return "part hello " + name;', '+    return "part hi " + name;', ' }', ' '] }]
		});
		await settle(); await open('part.ts'); await settle();
		check('a change by which Claude Code replaced a part of a line is marked', await origins() === 'Claude', `changes: ${await origins() || 'nothing'}`);

		// 10a. Claude Code changes a file and stages it
		claudeEdits('staged.ts', '"staged hello " + name', '"staged hi " + name');
		await settle(); await open('staged.ts'); await settle();
		const beforeStaging = await origins();
		await claudeShell('git add src/staged.ts');
		await settle();
		check('a change that Claude Code staged is still under review', beforeStaging === 'Claude' && stagedFiles().split(' ').includes('staged.ts') && git('diff', '--name-only', '--', 'src/staged.ts') === '' && await origins() === 'Claude' && held() === 'staged.ts',
			`shown before it was staged: ${beforeStaging}; staged in git: ${stagedFiles()}; shown now: ${await origins() || 'nothing'}; held: ${held() || 'nothing'}`);

		// 10b. approving it: git has it staged already, so there is nothing to stage
		await approve();
		check('approving a change that Claude Code staged clears it, and leaves it staged', await origins() === '' && git('show', ':src/staged.ts').includes('"staged hi "') && held() === '', `shown: ${await origins() || 'nothing'}; staged version has the change: ${git('show', ':src/staged.ts').includes('"staged hi "')}; held: ${held() || 'nothing'}`);

		// 10c. Claude Code changes a file in two places and commits it
		claudeEdits('committed.ts', '"committed hello " + name', '"committed hi " + name');
		claudeEdits('committed.ts', '"committed bye " + name', '"committed see you " + name');
		const committed = await claudeShell(`git ${asClaude} commit -qm "by claude" src/committed.ts`);
		await settle(); await open('committed.ts'); await settle();
		check('a change that Claude Code committed is still under review, although git lists nothing for the file', committed && git('log', '-1', '--format=%s') === 'by claude' && git('status', '--porcelain', '--', 'src/committed.ts') === '' && await origins() === 'Claude Claude' && held() === 'committed.ts',
			`committed: ${git('log', '-1', '--format=%s')}; git lists for the file: "${git('status', '--porcelain', '--', 'src/committed.ts')}"; shown: ${await origins() || 'nothing'}; held: ${held() || 'nothing'}`);

		// 10d. approving one of the two, then a new start of the window
		await approve();
		const afterOne = await origins();
		await page.keyboard.press('Meta+Shift+p'); await page.waitForTimeout(600); await page.keyboard.type('Developer: Reload Window', { delay: 5 }); await page.waitForTimeout(900); await page.keyboard.press('Enter');
		await page.waitForTimeout(3000); await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await page.waitForTimeout(9000);
		await open('committed.ts'); await settle();
		check('an approval in a committed file is kept without staging anything, also when the window is loaded anew', afterOne === 'Claude' && await origins() === 'Claude' && git('status', '--porcelain', '--', 'src/committed.ts') === '' && held() === 'committed.ts',
			`left after one approval: ${afterOne || 'nothing'}; after the reload: ${await origins() || 'nothing'}; git lists for the file: "${git('status', '--porcelain', '--', 'src/committed.ts')}"; held: ${held() || 'nothing'}`);

		// 10e. approving the other one
		const toReviewBefore = await toReview();
		await approve();
		await open('committed.ts'); await settle(); // the review went on to the next file
		check('approving the last change of a committed file clears the file', await origins() === '' && held() === '' && git('status', '--porcelain', '--', 'src/committed.ts') === '' && git('log', '-1', '--format=%s') === 'by claude' && await toReview() !== toReviewBefore,
			`shown: ${await origins() || 'nothing'}; held: ${held() || 'nothing'}; the status bar said "${toReviewBefore}" and says "${await toReview()}"`);

		// 10f. a new file that Claude Code wrote and committed
		fs.writeFileSync(file('fresh.ts'), 'export const fresh = true;\n');
		runHooks('Write', { file_path: file('fresh.ts'), content: 'export const fresh = true;\n' }, { type: 'create', filePath: file('fresh.ts'), content: 'export const fresh = true;\n', structuredPatch: [], originalFile: null });
		await claudeShell(`git add src/fresh.ts && git ${asClaude} commit -qm "new by claude" src/fresh.ts`);
		await settle(); await open('fresh.ts'); await settle();
		const newFileBar = await bar();
		await page.locator('.editor-group-container.active .change-review-bar-widget .monaco-button', { hasText: 'Approve File' }).first().click(); await page.waitForTimeout(4000);
		await open('fresh.ts'); await settle();
		check('a new file that Claude Code committed is under review as a new file, and approving it clears it', newFileBar === 'New File · Claude' && git('status', '--porcelain', '--', 'src/fresh.ts') === '' && await bar() === '' && held() === '',
			`the bar said "${newFileBar}" and says "${await bar()}"; git lists for the file: "${git('status', '--porcelain', '--', 'src/fresh.ts')}"; held: ${held() || 'nothing'}`);

		// 10f2. a file that Claude Code deleted, with the deletion committed
		const removed = await claudeShell(`git rm -q src/gone.ts && git ${asClaude} commit -qm "removed by claude" src/gone.ts`);
		await settle();
		const heldAfterRemoval = held();
		let deletedBar = '';
		for (let step = 0; step < 8 && !deletedBar.startsWith('Deleted File'); step++) {
			await nextFile();
			deletedBar = await bar();
		}
		const shownAsDeleted = deletedBar.startsWith('Deleted File') && await page.evaluate(() => /gone.hello/.test(document.querySelector('.editor-group-container.active .view-lines')?.textContent ?? ''));
		if (shownAsDeleted) { await page.locator('.editor-group-container.active .change-review-bar-widget .monaco-button', { hasText: 'Approve File' }).first().click(); await page.waitForTimeout(4000); }
		check('a file that Claude Code deleted and committed is under review as a deleted file of Claude Code, and approving it clears it', removed && !fs.existsSync(file('gone.ts')) && heldAfterRemoval === 'gone.ts' && shownAsDeleted && deletedBar === 'Deleted File · Claude' && held() === '',
			`removed and committed: ${removed && git('log', '-1', '--format=%s') === 'removed by claude'}; held after that: ${heldAfterRemoval || 'nothing'}; the bar said "${deletedBar}"; shows what is gone: ${shownAsDeleted}; held after the approval: ${held() || 'nothing'}`);

		// 10g. a change that the reviewer stages in their own git tool
		fs.writeFileSync(file('outside.ts'), read('outside.ts').replace('"outside hello " + name', '"outside hi " + name'));
		await settle(); await open('outside.ts'); await settle();
		const beforeOwnStaging = await origins();
		git('add', 'src/outside.ts');
		await settle(); await page.waitForTimeout(3000);
		check('a change that the reviewer staged outside the editor counts as reviewed', beforeOwnStaging === '-' && await origins() === '' && held() === '', `shown before: ${beforeOwnStaging}; shown after: ${await origins() || 'nothing'}; held: ${held() || 'nothing'}`);

		// 10g2. the same for a file that Claude Code staged before: the reviewer stages what there is by then
		claudeEdits('outside.ts', '"outside bye " + name', '"outside so long " + name');
		await claudeShell('git add src/outside.ts');
		await settle();
		const heldBeforeOwnStaging = held();
		fs.writeFileSync(file('outside.ts'), read('outside.ts').replace('version = 1', 'version = 3'));
		await settle();
		const shownWhileHeld = await origins();
		git('add', 'src/outside.ts');
		await settle(); await page.waitForTimeout(3000);
		check('a file that Claude Code staged counts as reviewed once the reviewer stages it themselves', heldBeforeOwnStaging === 'outside.ts' && shownWhileHeld === '- Claude' && await origins() === '' && held() === '',
			`held after Claude Code staged it: ${heldBeforeOwnStaging || 'nothing'}; shown then: ${shownWhileHeld || 'nothing'}; shown after the reviewer staged it: ${await origins() || 'nothing'}; held: ${held() || 'nothing'}`);

		// 10h. the reviewer approves a change while a shell command of Claude Code runs that names git
		fs.writeFileSync(file('during.ts'), read('during.ts').replace('"during hello " + name', '"during hi " + name'));
		await settle(); await open('during.ts'); await settle();
		const beforeApproval = await origins();
		await claudeShell('git stash list && git status --short', approve); // a command that could stage, and that long
		await settle();
		check('an approval that is staged while a shell command of Claude Code runs is not taken for Claude staging', beforeApproval === '-' && await origins() === '' && git('show', ':src/during.ts').includes('"during hi "') && held() === '',
			`shown before: ${beforeApproval}; shown after: ${await origins() || 'nothing'}; staged: ${git('show', ':src/during.ts').includes('"during hi "')}; held: ${held() || 'nothing'}`);

		// 10i. Claude Code switches to another branch and back: what differs there was committed before
		const switched = await claudeShell('git checkout -q other');
		const onOther = read('branch.ts').includes('version = 2');
		await settle();
		const heldOnOther = held();
		await claudeShell('git checkout -q -');
		await settle(); await open('branch.ts'); await settle();
		check('a file that differs on another branch is not under review after Claude Code switched branches', switched && onOther && heldOnOther === '' && held() === '' && await origins() === '', `switched: ${switched && onOther}; held on the other branch: ${heldOnOther || 'nothing'}; held now: ${held() || 'nothing'}; shown: ${await origins() || 'nothing'}`);

		// 10i2. files that are deleted without git: one by a shell command of Claude Code, one by another program
		const erased = await claudeShell('rm src/erased.ts');
		fs.rmSync(file('dropped.ts'));
		await settle();
		const deletedBars = new Map<string, string>();
		for (let step = 0; step < 20 && deletedBars.size < 2; step++) {
			await nextFile();
			const tab = /(?<name>(erased|dropped)\.ts) \(Deleted\)/.exec(await activeTab())?.groups?.name;
			if (tab) { deletedBars.set(tab, await bar()); }
		}
		check('a file that a shell command of Claude Code deleted is marked as deleted by Claude Code, and one that another program deleted is not', erased && !fs.existsSync(file('erased.ts')) && deletedBars.get('erased.ts') === 'Deleted File · Claude' && deletedBars.get('dropped.ts') === 'Deleted File' && deletions() === 'erased.ts 0' && git('status', '--porcelain', '--', 'src/erased.ts') === 'D src/erased.ts',
			`erased.ts: "${deletedBars.get('erased.ts') ?? 'not shown'}"; dropped.ts: "${deletedBars.get('dropped.ts') ?? 'not shown'}"; on record as taken away, with the number of lines kept: ${deletions() || 'nothing'}`);

		// 10j. what is kept about staging
		const kept = ['held', 'own', 'repos'].flatMap(folder => fs.existsSync(path.join(record, folder)) ? fs.readdirSync(path.join(record, folder)).map(name => fs.readFileSync(path.join(record, folder, name), 'utf8')) : []);
		check('what is kept about staging names versions by their id, and holds no line of any file', kept.length >= 4 && !kept.some(text => /hello|bye|see you|" \+ name|export /.test(text)) && !fs.existsSync(path.join(record, 'pending', 'toolu_shell1')),
			`files kept: ${kept.length}; one of them: ${kept.find(text => text.includes('"reviewed"'))?.slice(0, 150)}`);

		// 10k. Claude Code waits for the hook before a shell command, and takes an error of it as an objection
		const scriptFile = path.join(record, 'hook.sh');
		const script = fs.readFileSync(scriptFile, 'utf8');
		const accepted = cp.spawnSync('/bin/sh', ['-n', scriptFile]).status === 0;
		const hookBefore = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks.PreToolUse[0].hooks[0];
		fs.writeFileSync(scriptFile, 'if then fi ((\n');
		const broken = cp.spawnSync('/bin/sh', ['-c', hookBefore.command], { input: JSON.stringify({ cwd: ws, tool_name: 'Bash', tool_input: { command: 'git add .' }, tool_use_id: 'toolu_broken' }) });
		fs.writeFileSync(scriptFile, script);
		check('the hook before a shell command ends well and says nothing, also when its script is broken', accepted && broken.status === 0 && broken.stdout.length + broken.stderr.length === 0 && hookBefore.timeout === 10,
			`the shell accepts the script: ${accepted}; with a broken script the hook ends with ${broken.status} and writes ${broken.stdout.length + broken.stderr.length} bytes; Claude Code gives up on it after ${hookBefore.timeout} s`);

		// 10. the connection says that it hears from Claude Code, and disconnecting gives the settings back
		await page.keyboard.press('Meta+Shift+p'); await page.waitForTimeout(600); await page.keyboard.type('Claude Code Connection', { delay: 5 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(2000);
		const state = await dialog();
		check('the connection says when it last heard from Claude Code, and from where', /Claude Code Is Connected/.test(state) && /Last heard from Claude Code .*desktop app/.test(state), state.slice(0, 170));
		await press('Disconnect'); await page.waitForTimeout(1500);
		check('disconnecting gives the settings of Claude Code back as they were', fs.readFileSync(settingsFile, 'utf8') === settingsBefore && await offer() === 1, `settings as before: ${fs.readFileSync(settingsFile, 'utf8') === settingsBefore}; offer back: ${await offer()}`);
		await open('made.ts'); await settle();
		check('what is on record stays after disconnecting', await bar() === 'New File · Claude', `made.ts: "${await bar()}"`);

		// 11. a connection as the version before this one made it: its two hooks, and none before a shell command
		const earlier = JSON.parse(settingsBefore);
		const earlierHook = (kind: string) => ({ type: 'command', command: `f='${path.join(record, 'hook.sh')}'; [ ! -f "$f" ] || exec sh "$f" ${kind} # vs-kot change review` });
		earlier.hooks.PostToolUse = [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [earlierHook('edit')] }, { matcher: 'Bash', hooks: [earlierHook('shell')] }];
		fs.writeFileSync(settingsFile, JSON.stringify(earlier, undefined, 2) + '\n');
		await page.waitForTimeout(3000);
		const updateOffer = page.locator('.statusbar-item', { hasText: 'Update Claude Code Connection' });
		const offersUpdate = await updateOffer.count();
		await updateOffer.first().click(); await page.waitForTimeout(1500);
		const updateQuestion = await dialog();
		const untouched = fs.readFileSync(settingsFile, 'utf8') === JSON.stringify(earlier, undefined, 2) + '\n';
		await press('Update'); await page.waitForTimeout(1500);
		const updated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
		check('a connection that an earlier version made is offered an update, which asks before it adds its hooks', offersUpdate === 1 && /Update the Connection of Claude Code/.test(updateQuestion) && untouched && hookCount(updated) === 'PostToolUse 2, PreToolUse 1, PostToolUseFailure 1' && await updateOffer.count() === 0,
			`offers: ${offersUpdate}; asked: ${updateQuestion.slice(0, 80)}; settings untouched until confirmed: ${untouched}; hooks after: ${hookCount(updated)}`);
	} catch (e) { check('the run finished', false, String(e && (e as Error).message || e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	try { app.process().kill('SIGKILL'); } catch { /* gone already */ }
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
