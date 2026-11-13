/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: checks the updater from end to end with the packaged app. An older copy of the app is installed in a test
// folder and finds the real build as a newer release on a server that runs on this Mac. Six cases:
//
//   1. it downloads the release, and "Update" in the title bar replaces the app and opens the new one
//   2. it downloads the release, and simply quitting replaces the app
//   3. the zip was changed on the way and no longer has the announced SHA-256: nothing is installed
//   4. the release is not signed: nothing is downloaded
//   5. the release announces another zip than the one that was signed: nothing is downloaded
//   6. the app's folder cannot be written: the release is only offered, nothing is downloaded
//
//   node .vs-kot/release-check/update-check.ts ../VSCode-darwin-arm64/vs-kot.app [folder for the test installation]
//
// Run it after .vs-kot/package.sh has built and signed the release, before publishing. The signature is taken from the
// latest.json next to the app; the release key itself is not needed here. It takes about nine minutes and opens the
// app several times.
// The app is started the way a double click does it (through `open`), so macOS treats it as it would treat the real
// one. Everything lives in ~/Library/Caches/vs-kot-update-check, away from Documents, where macOS would first ask
// for folder access. Give a second argument, for example /Applications/vs-kot-update-check, to try the exchange in
// another place; the folder is removed again at the end. Set KEEP=1 to keep the test folders for a look.

import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';

const source = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(path.join(source, 'Contents', 'Resources', 'app', 'product.json'))) {
	console.log('usage: node .vs-kot/release-check/update-check.ts <path to the packaged vs-kot.app> [folder for the test installation]');
	process.exit(2);
}
const root = path.join(os.homedir(), 'Library', 'Caches', 'vs-kot-update-check');
const installDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, 'install');
const app = path.join(installDir, path.basename(source));
const productPath = path.join(app, 'Contents', 'Resources', 'app', 'product.json');
const ud = path.join(root, 'ud');
const ws = path.join(root, 'ws');
const updateHome = path.join(ud, 'app-update');
const cdpPort = 9741;
const oldVersion = '0.0.1';
const sourceProduct = JSON.parse(fs.readFileSync(path.join(source, 'Contents', 'Resources', 'app', 'product.json'), 'utf8'));
const newVersion: string = sourceProduct.vsKotVersion;
const hasReleaseKey = (sourceProduct.vsKotUpdatePublicKeys ?? []).length > 0;

setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 20 * 60 * 1000).unref();
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const run = (command: string, args: string[]) => cp.execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const installedVersion = () => { try { return JSON.parse(read(productPath)).vsKotVersion as string; } catch { return 'no app'; } };
const appPids = () => run('/bin/ps', ['-axww', '-o', 'pid=,command=']).split('\n').filter(line => line.includes(`${app}/Contents/MacOS/`)).map(line => parseInt(line, 10));
const mainLog = () => { const logs = path.join(ud, 'logs'); const runs = fs.existsSync(logs) ? fs.readdirSync(logs).sort() : []; return runs.length ? read(path.join(logs, runs[runs.length - 1], 'main.log')) : ''; };
async function until(what: string, test: () => boolean | Promise<boolean>, seconds: number): Promise<boolean> {
	for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(500)) {
		if (await test()) { return true; }
	}
	console.log(`      gave up waiting for: ${what}`);
	return false;
}

// The release on offer: the real build, as a zip, described by a manifest that each case may bend.
const zip = fs.existsSync(path.join(path.dirname(source), 'vs-kot-darwin-arm64.zip')) ? path.join(path.dirname(source), 'vs-kot-darwin-arm64.zip') : path.join(root, 'new.zip');
let announcedSha = '';
let announcedSignature: string | undefined;
let changeZipOnTheWay = false;
let zipDownloads = 0;
// Like GitHub, the server sends two redirects before each file, the first one to another host name.
const server = http.createServer((request, response) => {
	const port = (server.address() as { port: number }).port;
	const redirect = (location: string) => { response.statusCode = 302; response.setHeader('location', location); response.end(); };
	if (request.url === '/latest.json' || request.url === '/vs-kot.zip') {
		redirect(`http://localhost:${port}/hop${request.url}`);
	} else if (request.url === '/hop/latest.json' || request.url === '/hop/vs-kot.zip') {
		redirect(`http://127.0.0.1:${port}/files${request.url.substring('/hop'.length)}`);
	} else if (request.url === '/files/latest.json') {
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ version: newVersion, commit: 'update-check', date: new Date().toISOString(), assets: { 'darwin-arm64': { url: `http://127.0.0.1:${port}/vs-kot.zip`, sha256: announcedSha, signature: announcedSignature } } }));
	} else if (request.url === '/files/vs-kot.zip') {
		zipDownloads++;
		response.setHeader('content-length', fs.statSync(zip).size + (changeZipOnTheWay ? 1 : 0));
		fs.createReadStream(zip).on('end', () => response.end(changeZipOnTheWay ? 'x' : undefined)).pipe(response, { end: false });
	} else {
		response.statusCode = 404; response.end();
	}
});

/** Installs a copy of the build that believes it is an old release and looks for updates on our server. */
function installOldCopy(): void {
	fs.rmSync(ud, { recursive: true, force: true });
	fs.rmSync(app, { recursive: true, force: true });
	fs.mkdirSync(installDir, { recursive: true });
	run('/bin/cp', ['-Rc', source, app]);
	const product = JSON.parse(read(productPath));
	product.vsKotVersion = oldVersion;
	product.updateUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	fs.writeFileSync(productPath, JSON.stringify(product, null, '\t'));
	run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
}

function start(): void {
	run('/usr/bin/open', ['-n', app, '--args', ws, `--user-data-dir=${ud}`, `--extensions-dir=${path.join(root, 'ext')}`, `--remote-debugging-port=${cdpPort}`, '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-workspace-trust', '--use-inmemory-secretstorage', '--use-mock-keychain']);
}

/** The workbench window of the running test app, reached the way a browser's developer tools reach a page. */
async function withWindow<T>(action: (page: import('playwright').Page) => Promise<T>): Promise<T> {
	let browser: import('playwright').Browser | undefined;
	await until('the app to accept a connection', async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); return true; } catch { return false; } }, 90);
	if (!browser) { throw new Error('the app accepts no connection'); }
	try {
		let page: import('playwright').Page | undefined;
		const connected = browser;
		await until('the window', async () => { for (const p of connected.contexts().flatMap(c => c.pages())) { if (await p.locator('.monaco-workbench').count()) { page = p; return true; } } return false; }, 90);
		if (!page) { throw new Error('no window'); }
		return await action(page);
	} finally {
		await browser.close();
	}
}

async function quit(): Promise<boolean> {
	for (const pid of appPids()) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
	return until('the app to quit', () => appPids().length === 0, 60);
}

(async () => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(ws, { recursive: true });
	fs.writeFileSync(path.join(ws, 'note.txt'), 'A folder for the update check.\n');
	if (!fs.existsSync(zip)) { run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', source, zip]); }
	const realSha = await new Promise<string>((resolve, reject) => { const hash = crypto.createHash('sha256'); fs.createReadStream(zip).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject); });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const built = (() => { try { return JSON.parse(read(path.join(path.dirname(source), 'latest.json'))).assets['darwin-arm64'] as { sha256?: string; signature?: string }; } catch { return undefined; } })();
	const realSignature = built?.sha256 === realSha ? built.signature : undefined;
	check('0. the build carries a release key, and the latest.json next to it is signed', hasReleaseKey && !!realSignature, hasReleaseKey ? (realSignature ? '' : 'run .vs-kot/sign-release.sh first') : 'product.json has no vsKotUpdatePublicKeys');
	if (!hasReleaseKey || !realSignature) { server.close(); console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(1); }
	console.log(`offering vs-kot ${newVersion} to a copy that calls itself ${oldVersion}, installed in ${installDir}`);

	try {
		// 1. Download, then "Update" in the title bar
		announcedSha = realSha; announcedSignature = realSignature; installOldCopy(); start();
		let ready = await until('the update to be downloaded and checked', () => /update#setState ready/.test(mainLog()), 240);
		check('1. the newer release is found, downloaded and checked', ready && fs.existsSync(path.join(updateHome, 'work', 'unpacked', path.basename(app))), `${zipDownloads} download(s)`);
		if (ready) {
			const flagged = cp.spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path.join(updateHome, 'work', 'unpacked', path.basename(app))]).status === 0;
			check('1. the downloaded app carries no download flag (no Gatekeeper detour)', !flagged);
			const clicked = Date.now();
			const label = await withWindow(async page => {
				const indicator = page.locator('.update-indicator.prominent');
				await indicator.waitFor({ timeout: 30000 });
				const text = (await indicator.innerText()).trim();
				await page.screenshot({ path: path.join(root, 'update-ready.png') });
				await indicator.click();
				return text;
			});
			check('1. the title bar offers the update', label === 'Update', `button "${label}"`);
			const swapped = await until('the new version to be in place', () => installedVersion() === newVersion, 90);
			const reopened = swapped && await until('the app to open again', () => appPids().length > 0, 60);
			check('1. "Update" replaces the app and opens the new one', swapped && reopened, `installed version is ${installedVersion()}, ${Math.round((Date.now() - clicked) / 1000)} s after the click; script says: ${read(path.join(updateHome, 'apply.log')).trim().split('\n').pop()}`);
			if (reopened) {
				const title = await withWindow(async page => { await page.screenshot({ path: path.join(root, 'after-update.png') }); return page.title(); });
				check('1. the new app comes back with the same folder and profile', title.includes(path.basename(ws)) && fs.readdirSync(path.join(ud, 'logs')).length === 2, `window title "${title}", ${fs.readdirSync(path.join(ud, 'logs')).length} runs in the profile's log folder`);
				check('1. nothing is left of the download, and nothing next to the app', !fs.existsSync(path.join(updateHome, 'work')) && fs.readdirSync(installDir).every(name => !name.startsWith('.' + path.basename(app))), fs.readdirSync(installDir).join(', '));
			}
		}
		await quit();

		// 2. Download, then simply quit
		announcedSha = realSha; announcedSignature = realSignature; installOldCopy(); start();
		ready = await until('the update to be downloaded and checked', () => /update#setState ready/.test(mainLog()), 240);
		const gone = ready && await quit();
		const swappedOnQuit = gone && await until('the new version to be in place', () => installedVersion() === newVersion, 60);
		await sleep(5000);
		check('2. quitting with a downloaded update replaces the app', !!swappedOnQuit, `installed version is ${installedVersion()}; script says: ${read(path.join(updateHome, 'apply.log')).trim().split('\n').pop()}`);
		check('2. the app stays closed after a plain quit', appPids().length === 0);

		// 3. The zip was changed on the way
		announcedSha = realSha; announcedSignature = realSignature; changeZipOnTheWay = true; installOldCopy(); start();
		const refused = await until('the download to be refused', () => /could not prepare version/.test(mainLog()), 240);
		await sleep(2000);
		check('3. a zip that no longer has the announced SHA-256 is thrown away', refused && /Hash mismatch/.test(mainLog()) && !fs.existsSync(path.join(updateHome, 'work')), (mainLog().split('\n').find(line => /could not prepare version/.test(line)) ?? '').slice(-90));
		await quit(); await sleep(3000);
		check('3. and the app is unchanged after quitting', installedVersion() === oldVersion && !fs.existsSync(path.join(updateHome, 'apply.log')), `installed version is ${installedVersion()}`);
		changeZipOnTheWay = false;

		// 4. and 5. A release that the release key did not sign, and one whose signature belongs to another zip
		for (const [name, sha, signature] of [['4. a release without a signature', realSha, undefined], ['5. a release that announces another zip than the signed one', '0'.repeat(64), realSignature]] as const) {
			announcedSha = sha; announcedSignature = signature; zipDownloads = 0; installOldCopy(); start();
			const turnedDown = await until('the release to be turned down', () => /not signed with the release key/.test(mainLog()), 120);
			await sleep(2000);
			check(`${name} is turned down before anything is downloaded`, turnedDown && zipDownloads === 0 && !/update#setState downloading/.test(mainLog()), `${zipDownloads} download(s); ${(mainLog().split('\n').find(line => /not signed with the release key/.test(line)) ?? '').slice(-100)}`);
			await quit(); await sleep(2000);
		}
		check('4. and 5. the app is unchanged', installedVersion() === oldVersion, `installed version is ${installedVersion()}`);

		// 6. The app's folder cannot be written
		announcedSha = realSha; announcedSignature = realSignature; installOldCopy(); zipDownloads = 0;
		fs.chmodSync(installDir, 0o555);
		try {
			start();
			const offered = await until('the update to be offered', () => /update#setState available for download/.test(mainLog()), 120);
			check('6. where the app cannot replace itself, the release is only offered', offered && zipDownloads === 0, `${zipDownloads} download(s)`);
			await quit();
		} finally {
			fs.chmodSync(installDir, 0o755);
		}
	} catch (e) {
		check('the run finished', false, String(e instanceof Error ? e.stack : e).slice(0, 400));
	}

	await quit();
	server.close();
	if (!process.env.KEEP) {
		fs.rmSync(root, { recursive: true, force: true });
		if (process.argv[3]) { fs.rmSync(app, { recursive: true, force: true }); try { fs.rmdirSync(installDir); } catch { /* not empty: not ours to remove */ } }
	}
	console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`); process.exit(results.every(Boolean) ? 0 : 1);
})();
