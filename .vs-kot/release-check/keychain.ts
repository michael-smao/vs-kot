/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: does the editor stay away from the keychain of macOS? The app is signed ad hoc, so every update is a new
// app to macOS, and an editor that reads its entry in the keychain makes macOS ask for the keychain's password.
// This check starts the editor the way a user does, without the switches the other checks use to keep it off the
// keychain, and has a small extension store a secret and read it back, twice, with a restart in between.
//
//   node .vs-kot/release-check/keychain.ts                                  the source build
//   PACKAGED_APP=<path to vs-kot.app> node .vs-kot/release-check/keychain.ts
//
// An editor that does reach for the keychain stops at the question of macOS, and the check fails after a minute
// with that question on the screen. To try the check on such an editor without the question, add MOCK_KEYCHAIN=1:
// the editor then gets a stand-in for the keychain from Chromium.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { getIsolatedClaudeRecord, ISOLATED_PORT, repo, scratch } from './isolated.ts';

const packagedApp = process.env.PACKAGED_APP;
const mockKeychain = !!process.env.MOCK_KEYCHAIN;
// A profile of its own, so that this check can run next to another one. The path has to be short.
const root = path.join(repo, '.build', 'keychain-check'); const ud = path.join(root, 'ud');
const home = path.join(scratch, 'keychain');
const ws = path.join(home, 'ws');
const probe = path.join(home, 'probe');
const answer = path.join(probe, 'answer.json');
const appFolder = packagedApp ?? path.join(repo, '.build', 'electron', 'vs-kot.app');
const SECRET = 'kept-in-memory';

fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(probe, { recursive: true });
fs.writeFileSync(path.join(ws, 'notes.txt'), 'nothing to see\n');
// The extension that stores the secret. It says what it found before and after in a file next to itself.
fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'keychain-check', publisher: 'vs-kot-check', version: '0.0.1', engines: { vscode: '^1.90.0' }, main: './extension.js', activationEvents: ['onStartupFinished'] }));
fs.writeFileSync(path.join(probe, 'extension.js'), [
	`const fs = require('fs'); const path = require('path');`,
	`exports.activate = async context => {`,
	`	const found = {};`,
	`	try {`,
	`		found.before = await context.secrets.get('login') ?? null;`,
	`		await context.secrets.store('login', '${SECRET}');`,
	`		found.after = await context.secrets.get('login') ?? null;`,
	`	} catch (error) { found.error = String(error); }`,
	`	fs.writeFileSync(path.join(__dirname, 'answer.json'), JSON.stringify(found));`,
	`};`,
	''
].join('\n'));
fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ ...getIsolatedClaudeRecord(), 'changeReview.enabled': false, 'tabCompletion.enabled': false }));

// when the run takes too long, for example because the computer went to sleep, nothing of it is left running
let endEditor = () => { };
setTimeout(() => { console.log('HARD TIMEOUT'); endEditor(); process.exit(2); }, 300000).unref();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: boolean[] = []; const check = (name: string, ok: boolean, detail: string) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`); };

/** What the extension found, or nothing when it never got an answer from the editor. */
interface IFound { before?: string | null; after?: string | null; error?: string }

/**
 * Chromium can encrypt its cookies with a key from the keychain. Whether it does is a switch inside Electron: a
 * marker in its binary, then a version, a length and one character for every switch. The second one is this.
 * @returns '0' for off, '1' for on, 'r' for taken out of the build
 */
function getCookieEncryption(): string {
	const binary = fs.readFileSync(path.join(appFolder, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'));
	const marker = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
	const at = binary.indexOf(marker);
	return at < 0 ? 'no switches found' : String.fromCharCode(binary[at + marker.length + 3]);
}

/** The editor's entry in the keychain: when it was made and last changed. Reading that much asks nobody for a password. */
function getKeychainEntry(): string {
	const name = `${JSON.parse(fs.readFileSync(path.join(repo, 'product.json'), 'utf8')).nameShort} Safe Storage`;
	try {
		const entry = cp.execFileSync('security', ['find-generic-password', '-s', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		return `"${name}" ` + [...entry.matchAll(/"(?<field>cdat|mdat)".*?"(?<date>\d{14})Z/g)].map(match => `${match.groups!.field} ${match.groups!.date}`).join(' ');
	} catch {
		return `no "${name}"`;
	}
}

/** Starts the editor and waits for what the extension found. A minute without an answer means the editor is held up. */
async function run(): Promise<{ found: IFound | undefined; complaints: string[] }> {
	fs.rmSync(answer, { force: true });
	// A folder and a port for the model server that nothing else uses. The folder is empty, so no server is started.
	const env: Record<string, string | undefined> = { ...process.env, VS_KOT_TAB_COMPLETION_HOME: path.join(home, 'tab-completion'), VS_KOT_TAB_COMPLETION_PORT: String(ISOLATED_PORT + 40) }; delete env.ELECTRON_RUN_AS_NODE;
	if (packagedApp) { delete env.VSCODE_DEV; delete env.NODE_ENV; delete env.VSCODE_CLI; } else { Object.assign(env, { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }); }
	const app: ElectronApplication = await _electron.launch({ executablePath: path.join(appFolder, 'Contents', 'MacOS', 'vs-kot'), args: [...(packagedApp ? [] : [repo]), ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, `--extensionDevelopmentPath=${probe}`, '--log=trace', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--disable-workspace-trust', ...(mockKeychain ? ['--use-mock-keychain'] : [])], env, timeout: 120000 });
	endEditor = () => app.process().kill();
	let found: IFound | undefined; let complaints: string[] = [];
	try {
		const page: Page = await app.firstWindow({ timeout: 120000 });
		await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
		for (let i = 0; i < 120 && !fs.existsSync(answer); i++) { await sleep(500); }
		// what the editor says when it has nowhere to keep a secret comes right after the secret was stored
		await sleep(3000);
		found = fs.existsSync(answer) ? JSON.parse(fs.readFileSync(answer, 'utf8')) : undefined;
		complaints = await page.evaluate(() => [...document.querySelectorAll('.notification-list-item-message')].map(message => message.textContent ?? '')).then(messages => messages.filter(message => /keyring|encrypt/i.test(message)));
	} finally {
		await Promise.race([app.close(), sleep(15000)]);
		try { app.process().kill(); } catch { /* gone already */ }
	}
	return { found, complaints };
}

/** The lines of the main process's log, of every run, that show the editor asking the system to encrypt or decrypt. */
function getEncryptionRequests(): string[] {
	const logs = path.join(ud, 'logs');
	return fs.readdirSync(logs).flatMap(run => fs.readFileSync(path.join(logs, run, 'main.log'), 'utf8').split('\n'))
		.filter(line => /\[EncryptionMainService\] (Checking if encryption is available|Encrypting value|Decrypting value)/.test(line));
}

(async () => {
	const cookieEncryption = getCookieEncryption();
	check('Chromium does not encrypt its cookies with a key from the keychain', cookieEncryption === '0' || cookieEncryption === 'r', `the switch in Electron is "${cookieEncryption}"`);

	const entryBefore = getKeychainEntry();
	const first = await run();
	check('an extension can store a secret and read it back', first.found?.before === null && first.found.after === SECRET && !first.found.error, first.found ? JSON.stringify(first.found) : 'no answer within a minute: is the editor waiting for the keychain, with the question of macOS on the screen?');
	check('the editor does not complain that it has nowhere to keep it', first.complaints.length === 0, first.complaints.join(' | ') || 'no such message');

	const second = await run();
	check('the secret is gone after a restart', second.found?.before === null && !second.found.error, second.found ? JSON.stringify(second.found) : 'no answer within a minute');

	const stored = cp.execFileSync('sqlite3', ['-readonly', path.join(ud, 'User', 'globalStorage', 'state.vscdb'), `select count(*) from ItemTable where key like 'secret://%'`], { encoding: 'utf8' }).trim();
	check('no secret is written to the profile', stored === '0', `${stored} in the profile's storage`);

	const requests = getEncryptionRequests();
	check('the editor never asks the system to encrypt or decrypt', requests.length === 0, requests.length ? `${requests.length}, the first: ${requests[0]}` : 'nothing in the log of the main process, in both runs');

	const entryAfter = getKeychainEntry();
	check('the entry in the keychain is as it was', entryAfter === entryBefore, `before: ${entryBefore}; after: ${entryAfter}${mockKeychain ? ' (with a stand-in for the keychain, so this says nothing)' : ''}`);

	console.log(`\n${results.filter(Boolean).length} of ${results.length} passed${packagedApp ? ` on ${packagedApp}` : ' on the source build'}`);
	process.exit(results.every(Boolean) ? 0 : 1);
})().catch(error => { console.error(error); endEditor(); process.exit(1); });
