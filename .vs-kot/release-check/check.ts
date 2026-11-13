/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: checks the features of a build one after the other, in a real window: identity, activity bar, no AI,
// tab completion, locked formatting, change review. Run it before every release, on the source build and on the app.
//
//   .vs-kot/release-check/make-workspace.sh /tmp/vs-kot-check
//   node .vs-kot/release-check/check.ts /tmp/vs-kot-check                                                (source build)
//   PACKAGED_APP=../VSCode-darwin-arm64/vs-kot.app node .vs-kot/release-check/check.ts /tmp/vs-kot-check   (the app)
//
// Make the workspace anew before each run: the run changes its files. Tab completion has to be set up on this Mac.
// The profile for the app's run is kept under .build/, where macOS asks no folder-access questions, and away from
// .vs-kot/tp, which the run on the source build deletes. Approve is sent as Meta+z: on a German keyboard that is
// the key that types Cmd+Y.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron } from 'playwright';

const repo = path.resolve(import.meta.dirname, '..', '..');
const ws = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(path.join(ws, '.git'))) {
	console.log('usage: node .vs-kot/release-check/check.ts <workspace made by make-workspace.sh>');
	process.exit(2);
}
const packagedApp = process.env.PACKAGED_APP;
const root = packagedApp ? path.join(repo, '.build', 'pkgtest') : path.join(repo, '.vs-kot', 'tp'); const ud = path.join(root, 'ud');
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
// the opposite of every locked team setting: the locks have to win
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ 'changeReview.autoReveal': false, 'editor.formatOnSave': false, 'editor.tabSize': 2, 'prettier.tabWidth': 2, 'prettier.useTabs': true, ...(process.env.EXTRA ? JSON.parse(process.env.EXTRA) : {}) }));
setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 240000).unref();
const results = []; const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
(async () => {
	if (packagedApp) {
		const ext = fs.readdirSync(path.join(packagedApp, 'Contents', 'Resources', 'app', 'extensions'));
		const wanted = ['esbenp.prettier-vscode', 'formulahendry.auto-close-tag', 'formulahendry.auto-rename-tag', 'dsznajder.es7-react-js-snippets', 'vs-kot-tab-completion'];
		check('team extensions are inside the app', wanted.every(w => ext.some(e => e.startsWith(w))), wanted.filter(w => !ext.some(e => e.startsWith(w))).join(', ') || `${ext.length} built-in extensions`);
		check('the Copilot extension is not inside the app', !ext.some(e => /copilot/i.test(e)));
		// the updater itself is checked by update-check.ts; here only that the app is set up to use it
		const product = JSON.parse(fs.readFileSync(path.join(packagedApp, 'Contents', 'Resources', 'app', 'product.json'), 'utf8'));
		check('the app knows its release number and where updates come from', /^\d+\.\d+\.\d+$/.test(product.vsKotVersion ?? '') && /^https:\/\/.+\/releases\/latest\/download$/.test(product.updateUrl ?? ''), `${product.vsKotVersion} from ${product.updateUrl}`);
	}
	const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
	if (packagedApp) { delete env.VSCODE_DEV; delete env.NODE_ENV; delete env.VSCODE_CLI; } else { Object.assign(env, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }); }
	const app = await _electron.launch({ executablePath: packagedApp ? path.join(packagedApp, 'Contents', 'MacOS', 'vs-kot') : path.join(repo, '.build', 'electron', 'vs-kot.app', 'Contents', 'MacOS', 'vs-kot'), args: [...(packagedApp ? [] : [repo]), ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain', '--log=trace'], env, timeout: 120000 });
	try {
		const page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 }); await page.waitForTimeout(10000);
		const identity = await app.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion() }));
		check(packagedApp ? 'the app calls itself vs-kot' : 'the source build starts', packagedApp ? /vs-kot/i.test(identity.name) : true, `${identity.name} ${identity.version}`);
		const bar = await page.evaluate(() => [...document.querySelectorAll('.activitybar .action-item a.action-label')].map(a => (a.getAttribute('aria-label') || '').replace(/ \(.*/, '')));
		check('activity bar shows Search, Explorer, Tab Completion', JSON.stringify(bar) === JSON.stringify(['Search', 'Explorer', 'Tab Completion']), bar.join(', '));
		const aiVisible = await page.evaluate(() => [...document.querySelectorAll('[aria-label]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map(e => e.getAttribute('aria-label')).filter(l => /copilot|\bchat\b|agent/i.test(l)));
		check('no AI entry is visible in the window', aiVisible.length === 0, aiVisible.slice(0, 4).join(' | '));
		await page.keyboard.press('F1'); await page.waitForTimeout(600); await page.keyboard.type('Copilot', { delay: 10 }); await page.waitForTimeout(1200);
		const rows = await page.evaluate(() => [...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(r => r.getAttribute('aria-label') || r.textContent).slice(0, 5));
		check('the command palette has no Copilot commands', !rows.some(r => /copilot/i.test(r)), JSON.stringify(rows).slice(0, 120));
		await page.keyboard.press('Escape');
		const statusBar = async () => page.evaluate(() => [...document.querySelectorAll('.statusbar-item')].map(s => s.textContent.trim()).filter(t => /^Tab\b/.test(t)).join(' | '));
		for (let i = 0; i < 80 && !/^Tab$/.test(await statusBar()); i++) { await page.waitForTimeout(500); }
		check('tab completion is ready (status bar)', /^Tab$/.test(await statusBar()), `status bar says "${await statusBar()}"`);

		const open = async name => { await page.keyboard.press('Meta+p'); await page.waitForTimeout(500); await page.keyboard.type(name, { delay: 5 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(2500); };
		const goTo = async line => { await page.keyboard.press('Control+g'); await page.waitForTimeout(500); await page.keyboard.type(String(line), { delay: 10 }); await page.keyboard.press('Enter'); await page.waitForTimeout(400); await page.keyboard.press('End'); };
		const ghostText = () => page.evaluate(() => [...document.querySelectorAll('[class*="ghost-text"]')].map(e => e.textContent.replace(/ /g, ' ')).join('').trim());
		const lines = () => page.evaluate(() => [...document.querySelectorAll('.editor-group-container.active .view-line')].map(e => ({ top: e.getBoundingClientRect().top, text: e.textContent.replace(/ /g, ' ') })).sort((a, b) => a.top - b.top).map(l => l.text));
		const waitGhost = async ms => { const t = Date.now(); let g = ''; while (Date.now() - t < ms) { g = await ghostText(); if (g) { break; } await page.waitForTimeout(20); } return { g, ms: Date.now() - t }; };

		// --- tab completion
		await open('OrderService.ts');
		await page.locator('.editor-group-container.active .view-lines').first().click({ position: { x: 600, y: 420 } });
		await goTo(21); await page.keyboard.type('return `Order ${order.id} with ', { delay: 25 });
		let s = await waitGhost(12000); if (s.g) { await page.keyboard.press('Tab'); await page.waitForTimeout(500); }
		const text = (await lines()).find(l => l.includes('return `Order')) || '';
		check('rest of a line: suggested, and Tab leaves a clean line', !!s.g && /\$\{[^}]+\}[^`]*`;?\s*$/.test(text.slice(text.indexOf(' with ') + 6)) && (text.match(/`/g) || []).length === 2, `${s.ms} ms: ${text.trim().slice(0, 110)}`);
		await page.keyboard.press('Escape'); await goTo(18); await page.keyboard.press('Enter'); await page.keyboard.type('item', { delay: 25 });
		s = await waitGhost(15000); if (s.g) { await page.keyboard.press('Tab'); await page.waitForTimeout(700); }
		const all = await lines(); const at = all.findIndex(l => /itemCount|item\w*\(/.test(l) && !l.includes('//'));
		const method = at === -1 ? [] : all.slice(at, at + 5);
		check('whole small method in one Tab: signature and a body', !!s.g && method.length > 1 && /\{\s*$/.test(method[0]) && /return|reduce|for /.test(method.slice(1).join(' ')), `${s.ms} ms: ${method.map(l => l.trim()).join(' ⏎ ').slice(0, 170)}`);
		await page.keyboard.press('Escape');

		// --- locked formatting (the profile asks for the opposite)
		await open('messy.ts');
		await page.locator('.editor-group-container.active .view-lines').first().click({ position: { x: 600, y: 300 } });
		await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.type(' '); await page.keyboard.press('Meta+s'); await page.waitForTimeout(4000);
		const messy = fs.readFileSync(path.join(ws, 'src', 'messy.ts'), 'utf8');
		check('saving formats with Prettier at 4 spaces although the profile says otherwise', messy.includes('\n    return a + b;') && !messy.includes('\t'), JSON.stringify(messy).slice(0, 120));

		// --- change review
		await open('review.ts'); await page.waitForTimeout(2500);
		const review = await page.evaluate(() => ({ pills: [...document.querySelectorAll('.change-review-hunk-widget')].map(w => w.textContent.trim().slice(0, 60)), bar: (document.querySelector('.change-review-bar-widget')?.textContent || '').trim().slice(0, 80), added: document.querySelectorAll('.change-review-line-added').length, removed: document.querySelectorAll('.change-review-removed-zone').length }));
		check('an unstaged change is shown inline with Approve / Request Change', review.pills.length === 1 && /Approve/.test(review.pills[0]) && review.added > 0 && review.removed > 0, `pill "${review.pills[0] || ''}", bar "${review.bar}", ${review.added} added line(s), ${review.removed} removed block(s)`);
		await page.keyboard.press('Meta+1'); await page.waitForTimeout(500);      // focus the editor; a click could land on the removed lines
		await page.keyboard.press('Meta+z'); await page.waitForTimeout(3000);        // ⌘Y on a German keyboard
		const staged = cp.execSync('git diff --cached --name-only', { cwd: ws, encoding: 'utf8' }).trim();
		const unstaged = cp.execSync('git diff --name-only', { cwd: ws, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
		check('Approve (⌘Y) stages the change in git', staged.split('\n').includes('src/review.ts') && !unstaged.includes('src/review.ts'), `staged: ${staged.replace(/\n/g, ', ') || 'nothing'}`);
	} catch (e) { check('the run finished', false, String(e && e.message || e).slice(0, 300)); }
	await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
	const logs = cp.execSync(`find "${path.join(ud, 'logs')}" -name "*Tab Completion*" | head -1`, { encoding: 'utf8' }).trim();
	if (logs) { const l = fs.readFileSync(logs, 'utf8').split('\n'); console.log('      model answer times:', l.filter(x => /\[debug\] \d+ ms/.test(x)).map(x => x.match(/(\d+) ms/)[1]).join(', '), 'ms'); const p = l.filter(x => /prompt of/.test(x)).pop(); if (p) { console.log('      last prompt:', p.replace(/^.*prompt of/, 'prompt of').slice(0, 170)); } }
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
