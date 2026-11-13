/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the whole file. Upstream's macOS updater hands the work to Squirrel.Mac, which only installs an update that
// carries the same Apple developer signature as the running app. Our builds have no such signature, so this service
// does the work itself:
//
//   1. It reads `latest.json` from the newest release (`updateUrl` in product.json) and compares its release number
//      with ours (`vsKotVersion` in product.json).
//   2. It downloads the zip, checks its SHA-256 against the manifest, unpacks it and checks that the result is a
//      consistent vs-kot app of exactly that release.
//   3. When the app quits, a small shell script that outlives it exchanges the two app folders and, after
//      "Restart to Update", opens the new one.
//
// Everything it writes lives in `<user data>/app-update`. The states it moves through are upstream's, so the update
// indicator in the title bar and "Check for Updates..." work unchanged.

import { execFile, spawn } from 'child_process';
import * as electron from 'electron';
import * as fs from 'fs';
import { promisify } from 'util';
import { Delayer } from '../../../base/common/async.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { MutableDisposable } from '../../../base/common/lifecycle.js';
import { basename, dirname, join } from '../../../base/common/path.js';
import { IProductConfiguration } from '../../../base/common/product.js';
import { transform } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { checksum } from '../../../base/node/crypto.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IFileService } from '../../files/common/files.js';
import { ILifecycleMainService, IRelaunchHandler, IRelaunchOptions, ShutdownReason } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, IRequestService, isSuccess } from '../../request/common/request.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { isNewerVsKotVersion, isTrustedUpdateUrl, IVsKotReleaseManifest, parseVsKotVersion, toVsKotUpdate } from '../common/vsKotUpdate.js';
import { AbstractUpdateService } from './abstractUpdateService.js';

const execFileAsync = promisify(execFile);

/** An update that is downloaded, checked and waiting for the app to quit. */
interface IStagedUpdate {
	readonly update: IUpdate;
	/** The name of the unpacked app folder, as the zip calls it. */
	readonly appName: string;
}

/**
 * Runs after the app has quit. It is written to disk when an update is ready and started when the app quits.
 * The exchange itself is two renames inside one folder, done with the usual stop signals ignored, so that a logout
 * at the wrong moment cannot leave the Mac without the app.
 */
const applyScript = `#!/bin/sh
# Written by vs-kot. After the app has quit, this puts the downloaded version in its place and, when asked to, opens
# it again. Arguments: <pid of the app> <installed app> <downloaded app> <version> <relaunch|quit> [arguments for
# the reopened app...]
HERE="$(cd "$(dirname "$0")" && pwd)"
exec >>"$HERE/apply.log" 2>&1
PID="$1"; APP="$2"; NEW="$3"; VERSION="$4"; MODE="$5"
shift 5
INCOMING="$(dirname "$APP")/.$(basename "$APP").new"
OLD="$(dirname "$APP")/.$(basename "$APP").old"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$VERSION] $*"; }

reopen() {
	if [ "$MODE" = "relaunch" ]; then
		if [ "$#" -gt 0 ]; then /usr/bin/open -n "$APP" --args "$@"; else /usr/bin/open -n "$APP"; fi
	fi
}

give_up() {
	log "not installed: $1"
	echo "$VERSION" >"$HERE/failed"
	echo "$VERSION" >"$HERE/failed.unseen"
	rm -rf "$INCOMING"
	shift
	reopen "$@"
	exit 1
}

# 1. Wait until the app has quit.
i=0
while kill -0 "$PID" 2>/dev/null; do
	i=$((i + 1))
	if [ "$i" -gt 300 ]; then log "the app did not quit, nothing changed"; exit 0; fi
	sleep 0.1
done

# 2. Only exchange two app folders that are really there. And the same app may still be running a second time from
#    the same folder: leave it alone then; the update stays downloaded and is offered again.
if [ ! -d "$APP/Contents" ] || [ ! -d "$NEW/Contents" ]; then
	log "the installed or the downloaded app is missing, nothing changed"; reopen "$@"; exit 0
fi
case "$(ps -axww -o command=)" in
	*"$APP/Contents/MacOS/"*) log "the app is still running a second time, nothing changed"; reopen "$@"; exit 0 ;;
esac

# 3. Bring the new version next to the installed one first, so that the exchange itself is two quick renames.
rm -rf "$INCOMING" "$OLD"
mv "$NEW" "$INCOMING" || give_up "could not write next to $APP" "$@"

trap '' HUP INT TERM
if ! mv "$APP" "$OLD"; then
	give_up "could not move $APP aside" "$@"
fi
if ! mv "$INCOMING" "$APP"; then
	mv "$OLD" "$APP"
	give_up "could not move the new version into place" "$@"
fi
trap - HUP INT TERM

# 4. Tidy up and open the new version.
rm -rf "$OLD" || log "could not delete the previous version at $OLD"
rm -rf "$HERE/work" "$HERE/failed" "$HERE/failed.unseen"
log "installed"
reopen "$@"
`;

export class VsKotUpdateService extends AbstractUpdateService implements IRelaunchHandler {

	/** The installed app, for example `/Applications/vs-kot.app`. */
	private readonly appPath: string;
	/** Everything this service writes. */
	private readonly updateHome: string;
	/** The download and the unpacked app. Emptied whenever nothing is waiting to be installed. */
	private readonly workPath: string;
	private readonly unpackPath: string;
	private readonly stagedRecordPath: string;
	private readonly applyScriptPath: string;
	/** Holds the release number whose installation failed, written by the script. */
	private readonly failedPath: string;
	/** The same, until the user has been told once. */
	private readonly failedUnseenPath: string;

	private readonly running = this._register(new MutableDisposable<CancellationTokenSource>());
	private staged: IStagedUpdate | undefined;
	/** Releases whose download or check failed since the app started. They are not fetched again by themselves. */
	private readonly failedThisSession = new Set<string>();
	private applyScriptStarted = false;
	private relaunchingWithoutUpdate = false;

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IProductService productService: IProductService,
		@IApplicationStorageMainService applicationStorageMainService: IApplicationStorageMainService,
		@IMeteredConnectionService meteredConnectionService: IMeteredConnectionService,
		@IFileService private readonly fileService: IFileService,
		@INativeHostMainService private readonly nativeHostMainService: INativeHostMainService,
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService, telemetryService, applicationStorageMainService, meteredConnectionService, false);

		// <app>/Contents/Resources/app is where the app's code lives
		this.appPath = dirname(dirname(dirname(environmentMainService.appRoot)));
		this.updateHome = join(environmentMainService.userDataPath, 'app-update');
		this.workPath = join(this.updateHome, 'work');
		this.unpackPath = join(this.workPath, 'unpacked');
		this.stagedRecordPath = join(this.workPath, 'staged.json');
		this.applyScriptPath = join(this.updateHome, 'apply-update.sh');
		this.failedPath = join(this.updateHome, 'failed');
		this.failedUnseenPath = join(this.updateHome, 'failed.unseen');

		lifecycleMainService.setRelaunchHandler(this);

		// A downloaded update is also installed when the app is simply quit. The listener is added this late on
		// purpose: it then runs after the one of `relaunch()`, which decides through `handleRelaunch` whether the
		// app comes back by itself.
		this._register(lifecycleMainService.onWillShutdown(e => {
			if (e.reason === ShutdownReason.QUIT) {
				electron.app.once('quit', () => this.installOnQuit());
			}
		}));
	}

	//#region What upstream's base class asks for

	/** Upstream reads the release channel from product.json; the fork has one channel and does not name it there. */
	protected override getProductQuality(updateMode: string): string | undefined {
		return updateMode === 'none' ? undefined : 'stable';
	}

	protected buildUpdateFeedUrl(): string | undefined {
		const base = this.productService.updateUrl;
		if (!isTrustedUpdateUrl(base) || !parseVsKotVersion(this.productService.vsKotVersion)) {
			return undefined;
		}
		return `${base!.replace(/\/+$/, '')}/latest.json`;
	}

	protected override async postInitialize(): Promise<void> {
		// what an interrupted exchange may have left next to the app
		await Promise.allSettled(['new', 'old'].map(suffix => fs.promises.rm(join(dirname(this.appPath), `.${basename(this.appPath)}.${suffix}`), { recursive: true, force: true })));

		const staged = await this.readStaged();
		if (!staged) {
			await this.emptyWork();
			return;
		}

		// downloaded in an earlier run and not installed yet, for example because the app ran twice
		await fs.promises.writeFile(this.applyScriptPath, applyScript, { mode: 0o755 });
		this.staged = staged;
		this.setState(State.Ready(staged.update, false, false));
	}

	protected doCheckForUpdates(explicit: boolean): void {
		this.setState(State.CheckingForUpdates(explicit));

		const source = new CancellationTokenSource();
		this.running.value = source;
		void this.checkAndStage(explicit, source.token);
	}

	protected override async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		const update = state.update;

		// The app cannot replace itself here, or tried and failed: the release page is the way then.
		if (!(await this.installsByItself(update, true))) {
			if (this.productService.downloadUrl) {
				await this.nativeHostMainService.openExternal(undefined, this.productService.downloadUrl);
			}
			this.setState(State.Idle(UpdateType.Archive));
			return;
		}

		const source = new CancellationTokenSource();
		this.running.value = source;
		await this.stage(update, true, source.token);
	}

	protected override async doIsLatestVersion(_commit?: string, token: CancellationToken = CancellationToken.None): Promise<boolean | undefined> {
		try {
			return (await this.fetchLatest(token)) === undefined;
		} catch (err) {
			this.logService.error('update#vsKot - could not read the release manifest', err);
			return undefined;
		}
	}

	protected override doQuitAndInstall(): void {
		this.startApplyScript(true);
	}

	protected override async cancelUpdate(): Promise<void> {
		this.running.value?.cancel();
		this.running.clear();
		this.staged = undefined;
		await this.emptyWork();
	}

	handleRelaunch(options?: IRelaunchOptions): boolean {
		if (options?.addArgs || options?.removeArgs || this.state.type !== StateType.Ready) {
			// the app comes back by itself with other arguments: the update waits for the next quit
			this.relaunchingWithoutUpdate = true;
			return false;
		}

		return this.startApplyScript(true);
	}

	//#endregion

	//#region Check

	private async checkAndStage(explicit: boolean, token: CancellationToken): Promise<void> {
		let update: IUpdate | undefined;
		let installsByItself = false;
		let failedBefore: string | undefined;
		try {
			update = await this.fetchLatest(token);
			if (update) {
				installsByItself = await this.installsByItself(update, explicit);
				failedBefore = installsByItself ? undefined : await this.takeUnseenFailure(update);
			}
		} catch (err) {
			if (this.state.type === StateType.CheckingForUpdates) {
				this.logService.error('update#vsKot - could not read the release manifest', err);
				this.setState(State.Idle(UpdateType.Archive, explicit ? toErrorMessage(err) : undefined));
			}
			return;
		}

		// updates may have been switched off while the answer was on its way
		if (this.state.type !== StateType.CheckingForUpdates) {
			return;
		}

		if (!update) {
			this.setState(State.Idle(UpdateType.Archive, undefined, explicit || undefined));
		} else if (failedBefore) {
			this.setState(State.Idle(UpdateType.Archive, localize('vsKotUpdate.installFailed', "{0} could not replace itself with version {1}. Download that version and install it by hand.", this.productService.nameShort, failedBefore)));
		} else if (!installsByItself) {
			this.setState(State.AvailableForDownload(update));
		} else if (!this.deferAutomaticDownload(update, explicit)) {
			await this.stage(update, explicit, token);
		}
	}

	/** The newest release when it is newer than the running app, read from its manifest. */
	private async fetchLatest(token: CancellationToken): Promise<IUpdate | undefined> {
		const url = this.buildUpdateFeedUrl();
		if (!url) {
			return undefined;
		}

		const context = await this.requestService.request({ url, disableCache: true, callSite: 'vsKotUpdateService.fetchLatest' }, token);
		if (context.res.statusCode === 404) {
			return undefined; // no release carries a manifest yet
		}
		if (!isSuccess(context)) {
			throw new Error(localize('vsKotUpdate.checkFailed', "The check for updates failed (HTTP status {0}).", context.res.statusCode ?? 0));
		}

		return toVsKotUpdate(await asJson<IVsKotReleaseManifest>(context), this.productService.vsKotVersion, `darwin-${process.arch}`);
	}

	/**
	 * Whether the app downloads and installs this release itself. Not when its folder cannot be written, not when the
	 * installation of this release failed before, and without being asked not a second time after a failed download.
	 */
	private async installsByItself(update: IUpdate, explicit: boolean): Promise<boolean> {
		const version = update.productVersion ?? update.version;
		if (!explicit && this.failedThisSession.has(version)) {
			return false;
		}
		if (!this.appPath.endsWith('.app') || this.appPath.includes('/AppTranslocation/')) {
			return false; // not a normal installation, or started by macOS from a read-only copy
		}
		try {
			await fs.promises.access(this.appPath, fs.constants.W_OK);
			await fs.promises.access(dirname(this.appPath), fs.constants.W_OK);
		} catch {
			return false;
		}
		return (await this.readLine(this.failedPath)) !== version;
	}

	/** The release whose installation just failed, once: the user is told about it a single time. */
	private async takeUnseenFailure(update: IUpdate): Promise<string | undefined> {
		const failed = await this.readLine(this.failedUnseenPath);
		if (!failed) {
			return undefined;
		}
		await fs.promises.rm(this.failedUnseenPath, { force: true });
		return failed === (update.productVersion ?? update.version) ? failed : undefined;
	}

	//#endregion

	//#region Download, check and keep ready

	private async stage(update: IUpdate, explicit: boolean, token: CancellationToken): Promise<void> {
		const version = update.productVersion ?? update.version;
		try {
			const startTime = Date.now();
			this.setState(State.Downloading(update, explicit, false, 0, undefined, startTime));

			await this.emptyWork();
			await fs.promises.mkdir(this.workPath, { recursive: true });
			const zipPath = join(this.workPath, 'download.zip');
			await this.download(update, explicit, zipPath, startTime, token);
			await checksum(zipPath, update.sha256hash);
			if (token.isCancellationRequested) {
				return;
			}

			this.setState(State.Updating(update, explicit));
			const appName = await this.unpackAndCheck(zipPath, version);
			if (token.isCancellationRequested) {
				return;
			}

			const staged: IStagedUpdate = { update, appName };
			await fs.promises.writeFile(this.stagedRecordPath, JSON.stringify(staged));
			await fs.promises.writeFile(this.applyScriptPath, applyScript, { mode: 0o755 });
			this.staged = staged;
			this.logService.info(`update#vsKot - version ${version} is downloaded and will be installed when the app quits`);
			this.setState(State.Ready(update, explicit, false));
		} catch (err) {
			if (token.isCancellationRequested) {
				return;
			}
			this.logService.error(`update#vsKot - could not prepare version ${version}`, err);
			this.failedThisSession.add(version);
			await this.emptyWork();
			this.setState(State.Idle(UpdateType.Archive, explicit ? toErrorMessage(err) : undefined));
		}
	}

	private async download(update: IUpdate, explicit: boolean, zipPath: string, startTime: number, token: CancellationToken): Promise<void> {
		const context = await this.requestService.request({ url: update.url, callSite: 'vsKotUpdateService.download' }, token);
		if (!isSuccess(context)) {
			throw new Error(localize('vsKotUpdate.downloadFailed', "The download of the update failed (HTTP status {0}).", context.res.statusCode ?? 0));
		}

		const contentLength = context.res.headers['content-length'];
		const totalBytes = typeof contentLength === 'string' ? parseInt(contentLength, 10) : undefined;

		let downloadedBytes = 0;
		const progress = new Delayer<void>(500);
		const stream = transform<VSBuffer, VSBuffer>(context.stream, {
			data: data => {
				downloadedBytes += data.byteLength;
				progress.trigger(() => {
					if (this.state.type === StateType.Downloading) {
						this.setState(State.Downloading(update, explicit, false, downloadedBytes, totalBytes, startTime));
					}
				}).catch(() => undefined /* cancelled when the download ends */);
				return data;
			}
		}, chunks => VSBuffer.concat(chunks));

		try {
			await this.fileService.writeFile(URI.file(zipPath), stream);
		} finally {
			progress.dispose();
		}
	}

	/**
	 * Unpacks the zip and makes sure the result is what the manifest promised: one app folder with a consistent code
	 * signature, with our identifier and of exactly that release. Returns the name of the app folder.
	 */
	private async unpackAndCheck(zipPath: string, version: string): Promise<string> {
		await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, this.unpackPath]);
		await fs.promises.rm(zipPath, { force: true });

		const apps = (await fs.promises.readdir(this.unpackPath)).filter(name => name.endsWith('.app'));
		const invalid = () => new Error(localize('vsKotUpdate.invalid', "The downloaded update is not a valid {0} app.", this.productService.nameShort));
		if (apps.length !== 1) {
			throw invalid();
		}

		const app = join(this.unpackPath, apps[0]);
		await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
		const product: Partial<IProductConfiguration> = JSON.parse(await fs.promises.readFile(join(app, 'Contents', 'Resources', 'app', 'product.json'), 'utf8'));
		if (product.vsKotVersion !== version || product.darwinBundleIdentifier !== this.productService.darwinBundleIdentifier) {
			throw invalid();
		}

		return apps[0];
	}

	/** An update that an earlier run downloaded and that still waits to be installed. */
	private async readStaged(): Promise<IStagedUpdate | undefined> {
		try {
			const staged: Partial<IStagedUpdate> = JSON.parse(await fs.promises.readFile(this.stagedRecordPath, 'utf8'));
			const version = staged.update?.productVersion;
			if (!staged.update || !staged.appName || !staged.appName.endsWith('.app') || staged.appName.includes('/')) {
				return undefined;
			}
			if (!isNewerVsKotVersion(version, this.productService.vsKotVersion) || (await this.readLine(this.failedPath)) === version) {
				return undefined;
			}
			await fs.promises.access(join(this.unpackPath, staged.appName, 'Contents', 'Info.plist'));
			return { update: staged.update, appName: staged.appName };
		} catch {
			return undefined; // nothing waiting
		}
	}

	private async emptyWork(): Promise<void> {
		try {
			await fs.promises.rm(this.workPath, { recursive: true, force: true });
		} catch (err) {
			this.logService.warn('update#vsKot - could not empty the download folder', err);
		}
	}

	private async readLine(path: string): Promise<string | undefined> {
		try {
			return (await fs.promises.readFile(path, 'utf8')).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	//#endregion

	//#region Install

	private installOnQuit(): void {
		if (this.state.type === StateType.Ready && !this.relaunchingWithoutUpdate) {
			this.startApplyScript(false);
		}
	}

	/**
	 * Starts the script that exchanges the app once this process is gone. It must not be a child that dies with us,
	 * and it gets a plain environment, so that the reopened app starts as if opened from the Finder.
	 */
	private startApplyScript(reopen: boolean): boolean {
		if (!this.staged || this.applyScriptStarted || !this.appPath.endsWith('.app')) {
			return false;
		}

		const version = this.staged.update.productVersion ?? this.staged.update.version;
		const args = [this.applyScriptPath, String(process.pid), this.appPath, join(this.unpackPath, this.staged.appName), version, reopen ? 'relaunch' : 'quit', ...(reopen ? process.argv.slice(1) : [])];
		try {
			const child = spawn('/bin/sh', args, { detached: true, stdio: 'ignore', cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env['HOME'] } });
			child.on('error', err => this.logService.error('update#vsKot - could not start the install script', err));
			child.unref();
			this.applyScriptStarted = true;
			this.logService.info(`update#vsKot - version ${version} will be installed now that the app quits`);
			return true;
		} catch (err) {
			this.logService.error('update#vsKot - could not start the install script', err);
			return false;
		}
	}

	//#endregion
}
