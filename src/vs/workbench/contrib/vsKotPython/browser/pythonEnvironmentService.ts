/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, Throttler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isWindows } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationDefaults, IConfigurationRegistry, IExtensionInfo } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { FileChangeType, IFileService } from '../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, NeverShowAgainScope, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { EnvironmentVariableMutatorType, IEnvironmentVariableCollectionDescription, IEnvironmentVariableMutator } from '../../../../platform/terminal/common/environmentVariable.js';
import { VS_KOT_PYTHON_ENVIRONMENT_COLLECTION } from '../../../../platform/terminal/common/vsKotEnvironmentCollections.js';
import { isVirtualWorkspace } from '../../../../platform/workspace/common/virtualWorkspace.js';
import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IEnvironmentVariableCollectionWithPersistence, IEnvironmentVariableService } from '../../terminal/common/environmentVariable.js';
import { getActivationVariables, getEnvironmentCandidates, getPythonVersion, IActivationScripts, IPythonEnvironment, IPythonEnvironmentService, NO_PYTHON_ENVIRONMENT } from '../common/pythonEnvironment.js';

/** The command that lets the person choose the environment. */
export const SELECT_PYTHON_ENVIRONMENT_COMMAND = 'vsKotPython.selectEnvironment';

/** Where the chosen environment of a folder is kept: its URI, or {@link NO_PYTHON_ENVIRONMENT}. */
const STORAGE_KEY = 'vsKotPython.environment';

/** The extensions that look after Python environments themselves. With one of them installed, VS Kot steps aside. */
const PYTHON_EXTENSIONS = ['ms-python.python', 'ms-python.vscode-python-envs'];

/** How long a new environment is given to be written completely before VS Kot looks at it again. */
const INCOMPLETE_RETRY_DELAY = 5000;
const INCOMPLETE_RETRIES = 24;

/** A folder with a `pyvenv.cfg` but without a `bin/python` or any activation script: an environment still being made. */
const INCOMPLETE = 'incomplete';

/** The PowerShell activation script: `python -m venv` names it `Activate.ps1`, uv and virtualenv `activate.ps1`. */
const POWERSHELL_SCRIPTS = ['Activate.ps1', 'activate.ps1'];

/**
 * Finds the virtual environments in the open folders, lets the person choose one, and keeps the terminal environment,
 * the status bar entry and the interpreter of the built-in linters in step with the choice. Steps aside when
 * Microsoft's Python extension or its Python Environments extension is installed, which look after environments
 * themselves.
 */
export class PythonEnvironmentService extends Disposable implements IPythonEnvironmentService {

	declare readonly _serviceBrand: undefined;

	private _activeEnvironment: IPythonEnvironment | undefined;
	get activeEnvironment(): IPythonEnvironment | undefined { return this._activeEnvironment; }

	/** The chosen environment while its folder is gone, for example during `rm -rf .venv && uv venv`. */
	private _missingEnvironment: URI | undefined;

	private readonly _refreshThrottler = this._register(new Throttler());
	private readonly _rescanScheduler = this._register(new RunOnceScheduler(() => this._refresh(), 2000));
	private readonly _folderWatchers = this._register(new DisposableStore());
	/** Watchers of the folders whose `.venv` and `venv` are looked at, by URI. */
	private readonly _nestedWatchers = this._register(new DisposableMap<string, IDisposable>());
	private readonly _statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _linterDefaultsSource: IExtensionInfo = { id: VS_KOT_PYTHON_ENVIRONMENT_COLLECTION, displayName: localize('linterDefaultsSource', "Python Environment") };
	private _linterDefaults: IConfigurationDefaults | undefined;
	private _prompted = false;
	private _incompleteRetries = 0;

	constructor(
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IEnvironmentVariableService private readonly _environmentVariableService: IEnvironmentVariableService,
		@IWorkspaceTrustManagementService private readonly _workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@ILabelService private readonly _labelService: ILabelService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(toDisposable(() => this._setLinterDefaults(undefined)));
		this._register(this._workspaceTrustManagementService.onDidChangeTrust(() => this._refresh()));
		this._register(this._extensionService.onDidChangeExtensions(() => this._refresh()));
		this._register(this._contextService.onDidChangeWorkspaceFolders(() => {
			this._watchFolders();
			this._refresh();
		}));

		this._watchFolders();
		this._refresh();
	}

	async selectEnvironment(): Promise<void> {
		if (!await this._isAvailable()) {
			this._notificationService.info(localize('notAvailable', "A Python environment can only be chosen for a trusted folder on this computer."));
			return;
		}
		if (await this._isPythonExtensionInstalled()) {
			this._notificationService.info(localize('extensionInstalled', "The Python extension looks after the Python environment of this folder. Use its Select Interpreter command instead."));
			return;
		}

		const environments = await this._findEnvironments();
		if (environments.length === 0) {
			this._notificationService.info(localize('noEnvironment', "This folder has no Python environment. Make one, for example with 'python3 -m venv .venv' or 'uv venv', and choose it again."));
			return;
		}

		interface IEnvironmentItem extends IQuickPickItem {
			readonly environment: IPythonEnvironment | undefined;
		}

		const noneIsActive = !this._activeEnvironment && !this._missingEnvironment;
		const items: (IEnvironmentItem | IQuickPickSeparator)[] = environments.map(environment => ({
			label: this._getLabel(environment.uri),
			description: this._activeEnvironment?.uri.toString() === environment.uri.toString() ? localize('activeDescription', "Active") : undefined,
			detail: environment.version ? localize('pythonVersion', "Python {0}", environment.version) : undefined,
			environment
		}));
		items.push({ type: 'separator' }, {
			label: localize('noEnvironmentItem', "No Environment"),
			description: noneIsActive ? localize('activeDescription', "Active") : undefined,
			detail: localize('noEnvironmentDetail', "Terminals and linting use the Python on your PATH"),
			environment: undefined
		});

		const pick = await this._quickInputService.pick(items, {
			placeHolder: localize('selectPlaceholder', "Select the Python environment for new terminals and Python linting"),
			matchOnDetail: true
		});
		if (pick) {
			await this._choose(pick.environment);
		}
	}

	private _refresh(): void {
		this._refreshThrottler.queue(() => this._doRefresh()).catch(error => this._logService.error('[vs-kot] Python environment', error));
	}

	private async _doRefresh(): Promise<void> {
		if (!await this._isAvailable() || await this._isPythonExtensionInstalled()) {
			this._apply(undefined, undefined);
			return;
		}

		const environments = await this._findEnvironments();
		const stored = this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);

		if (stored === NO_PYTHON_ENVIRONMENT) {
			this._apply(undefined, undefined);
			return;
		}

		if (stored) {
			const environment = environments.find(candidate => candidate.uri.toString() === stored);
			if (environment) {
				this._apply(environment, undefined);
				return;
			}

			// The chosen environment is gone. It is not forgotten: it is used again once it is there again, for example
			// after `rm -rf .venv && uv venv`. Until then the status bar says that it is missing, and when its folder is
			// really gone the other environments are offered.
			const missing = URI.parse(stored);
			this._apply(undefined, missing);
			if (environments.length > 0 && !this._prompted && !await this._fileService.exists(missing)) {
				this._prompted = true;
				this._prompt(environments);
			}
			return;
		}

		this._apply(undefined, undefined);
		if (environments.length > 0 && !this._prompted) {
			this._prompted = true;
			this._prompt(environments);
		}
	}

	/** Whether the feature applies to this window: a trusted, local folder on macOS or Linux. Activating an environment runs its scripts. */
	private async _isAvailable(): Promise<boolean> {
		if (isWindows || this._environmentService.remoteAuthority || isVirtualWorkspace(this._contextService.getWorkspace())) {
			return false;
		}
		if (!this._contextService.getWorkspace().folders.some(folder => folder.uri.scheme === Schemas.file)) {
			return false;
		}
		await this._workspaceTrustManagementService.workspaceTrustInitialized;
		return this._workspaceTrustManagementService.isWorkspaceTrusted();
	}

	/** Waits for the installed extensions to be known: their first registration fires no change event. */
	private async _isPythonExtensionInstalled(): Promise<boolean> {
		await this._extensionService.whenInstalledExtensionsRegistered();
		return this._extensionService.extensions.some(extension => PYTHON_EXTENSIONS.some(id => ExtensionIdentifier.equals(extension.identifier, id)));
	}

	private _prompt(environments: readonly IPythonEnvironment[]): void {
		// "Don't Show Again" is a button of its own, so that declining is as easy as accepting.
		const neverShowAgain = { id: 'vsKotPython.dontAskToActivate', scope: NeverShowAgainScope.WORKSPACE, isSecondary: false };

		if (environments.length === 1) {
			const environment = environments[0];
			this._notificationService.prompt(Severity.Info,
				localize('activateOne', "This folder has a Python environment in {0}. Activate it in new terminals and use it for Python linting?", this._getLabel(environment.uri)),
				[{ label: localize('activate', "Activate"), run: () => this._choose(environment) }],
				{ neverShowAgain }
			);
		} else {
			this._notificationService.prompt(Severity.Info,
				localize('activateMany', "This folder has {0} Python environments. Choose one to activate in new terminals and to use for Python linting?", environments.length),
				[{ label: localize('chooseEnvironment', "Choose Environment..."), run: () => this.selectEnvironment() }],
				{ neverShowAgain }
			);
		}
	}

	/**
	 * Keeps the choice and applies it through the same checks as every refresh: a prompt or a quick pick may be
	 * answered long after it was shown, when the folder is no longer trusted or a Python extension was installed.
	 * The environment is looked at again too: one that was just made may have its activation scripts by now.
	 */
	private async _choose(environment: IPythonEnvironment | undefined): Promise<void> {
		this._storageService.store(STORAGE_KEY, environment ? environment.uri.toString() : NO_PYTHON_ENVIRONMENT, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._incompleteRetries = 0;
		await this._refreshThrottler.queue(() => this._doRefresh());
	}

	private _apply(environment: IPythonEnvironment | undefined, missingEnvironment: URI | undefined): void {
		if (this._store.isDisposed) {
			return;
		}
		this._activeEnvironment = environment;
		this._missingEnvironment = missingEnvironment;
		this._setTerminalEnvironment(environment);
		this._setLinterDefaults(environment ? joinPath(environment.uri, 'bin', 'python').fsPath : undefined);
		this._updateStatus();
	}

	/** Activates the environment in every new terminal, and in terminals that come back after a restart. */
	private _setTerminalEnvironment(environment: IPythonEnvironment | undefined): void {
		const variables = environment ? getActivationVariables(environment.uri.fsPath, environment.activationScripts) : [];
		if (variables.length === 0) {
			if (this._environmentVariableService.collections.has(VS_KOT_PYTHON_ENVIRONMENT_COLLECTION)) {
				this._environmentVariableService.delete(VS_KOT_PYTHON_ENVIRONMENT_COLLECTION);
			}
			return;
		}

		const map = new Map<string, IEnvironmentVariableMutator>(variables.map(([variable, value]) => [variable, { variable, value, type: EnvironmentVariableMutatorType.Replace, options: { applyAtProcessCreation: true } }]));
		const existing = this._environmentVariableService.collections.get(VS_KOT_PYTHON_ENVIRONMENT_COLLECTION);
		if (existing && existing.map.size === map.size && [...map].every(([variable, mutator]) => existing.map.get(variable)?.value === mutator.value)) {
			return; // unchanged: terminals are not asked to relaunch
		}

		const descriptionMap = new Map<string, IEnvironmentVariableCollectionDescription>([['', {
			description: localize('terminalDescription', "Activates the Python environment {0}", this._getLabel(environment!.uri))
		}]]);
		// Persistent, so that terminals that come back after a restart are activated before this service starts.
		const collection: IEnvironmentVariableCollectionWithPersistence = { map, descriptionMap, persistent: true, remoteAuthority: null };
		this._environmentVariableService.set(VS_KOT_PYTHON_ENVIRONMENT_COLLECTION, collection);
	}

	/**
	 * Hands the interpreter to the built-in linters, as defaults of this window: Ruff takes its `ruff` from the
	 * environment when it is installed there, BasedPyright resolves imports against it. Nothing is written into the
	 * project, and a setting the person made still wins.
	 */
	private _setLinterDefaults(pythonPath: string | undefined): void {
		if (this._linterDefaults?.overrides['python.pythonPath'] === pythonPath) {
			return;
		}

		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		if (this._linterDefaults) {
			registry.deregisterDefaultConfigurations([this._linterDefaults]);
			this._linterDefaults = undefined;
		}
		if (pythonPath) {
			this._linterDefaults = {
				overrides: {
					'python.pythonPath': pythonPath,
					'ruff.interpreter': [pythonPath]
				},
				source: this._linterDefaultsSource,
				donotCache: true
			};
			registry.registerDefaultConfigurations([this._linterDefaults]);
		}
	}

	private _updateStatus(): void {
		const entry = this._getStatusEntry();
		if (!entry) {
			this._statusEntry.clear();
		} else if (this._statusEntry.value) {
			this._statusEntry.value.update(entry);
		} else {
			this._statusEntry.value = this._statusbarService.addEntry(entry, 'status.vsKotPythonEnvironment', StatusbarAlignment.RIGHT, 100);
		}
	}

	private _getStatusEntry(): IStatusbarEntry | undefined {
		const name = localize('statusName', "Python Environment");

		const environment = this._activeEnvironment;
		if (environment) {
			const label = environment.version ? localize('statusLabel', "{0} ({1})", this._getLabel(environment.uri), environment.version) : this._getLabel(environment.uri);
			return {
				name,
				text: `$(python) ${label}`,
				ariaLabel: localize('statusAriaLabel', "Python environment {0}", label),
				tooltip: localize('statusTooltip', "The Python environment {0} is activated in new terminals that have shell integration, not in tasks, and is used for Python linting. Select to choose another one.", environment.uri.fsPath),
				command: SELECT_PYTHON_ENVIRONMENT_COMMAND
			};
		}

		if (this._missingEnvironment) {
			const label = localize('statusMissing', "Python Environment Missing");
			return {
				name,
				text: `$(warning) ${label}`,
				ariaLabel: label,
				tooltip: localize('statusMissingTooltip', "The chosen Python environment {0} is not there. It is used again as soon as it is. Select to choose another one.", this._missingEnvironment.fsPath),
				command: SELECT_PYTHON_ENVIRONMENT_COMMAND
			};
		}

		return undefined;
	}

	/** Looks again when a folder appears in or disappears from a workspace folder, e.g. after `uv venv`. */
	private _watchFolders(): void {
		this._folderWatchers.clear();
		this._nestedWatchers.clearAndDisposeAll();
		for (const folder of this._contextService.getWorkspace().folders) {
			if (folder.uri.scheme === Schemas.file) {
				this._folderWatchers.add(this._watch(folder.uri, undefined));
			}
		}
	}

	/**
	 * Watches one folder, without its subfolders. For a folder whose `.venv` and `venv` are looked at, only those
	 * two names count, so that the work in a project does not make VS Kot look again.
	 */
	private _watch(uri: URI, names: readonly string[] | undefined): IDisposable {
		const store = new DisposableStore();
		const watcher = store.add(this._fileService.createWatcher(uri, { recursive: false, excludes: [] }));
		store.add(watcher.onDidChange(event => {
			const relevant = names
				? names.some(name => event.contains(joinPath(uri, name), FileChangeType.ADDED, FileChangeType.DELETED))
				: event.gotAdded() || event.gotDeleted();
			if (relevant) {
				this._incompleteRetries = 0;
				this._rescanScheduler.schedule();
			}
		}));
		return store;
	}

	private async _findEnvironments(): Promise<IPythonEnvironment[]> {
		const environments: IPythonEnvironment[] = [];
		const nestedParents = new Map<string, URI>();
		let incomplete = false;

		for (const folder of this._contextService.getWorkspace().folders) {
			if (folder.uri.scheme !== Schemas.file) {
				continue;
			}

			let children;
			try {
				children = (await this._fileService.resolve(folder.uri)).children ?? [];
			} catch {
				continue;
			}

			const candidates = getEnvironmentCandidates(children.map(child => ({ name: child.name, isDirectory: child.isDirectory })));
			for (const segments of candidates) {
				if (segments.length === 2) {
					const parent = joinPath(folder.uri, segments[0]);
					nestedParents.set(parent.toString(), parent);
				}
			}

			const found = await Promise.all(candidates.map(segments => this._readEnvironment(folder, segments)));
			for (const environment of found) {
				if (environment === INCOMPLETE) {
					incomplete = true;
				} else if (environment) {
					environments.push(environment);
				}
			}
		}

		this._updateNestedWatchers(nestedParents);

		if (incomplete && this._incompleteRetries < INCOMPLETE_RETRIES) {
			this._incompleteRetries++;
			this._rescanScheduler.schedule(INCOMPLETE_RETRY_DELAY);
		}
		return environments;
	}

	/** Watches the folders one level down whose `.venv` and `venv` are looked at, so that `cd api && uv venv` is noticed. */
	private _updateNestedWatchers(parents: ReadonlyMap<string, URI>): void {
		if (this._store.isDisposed) {
			return;
		}
		for (const key of [...this._nestedWatchers.keys()]) {
			if (!parents.has(key)) {
				this._nestedWatchers.deleteAndDispose(key);
			}
		}
		for (const [key, uri] of parents) {
			if (!this._nestedWatchers.has(key)) {
				this._nestedWatchers.set(key, this._watch(uri, ['.venv', 'venv']));
			}
		}
	}

	private async _readEnvironment(folder: IWorkspaceFolder, segments: string[]): Promise<IPythonEnvironment | typeof INCOMPLETE | undefined> {
		const uri = joinPath(folder.uri, ...segments);

		let pyvenvConfig: string;
		try {
			pyvenvConfig = (await this._fileService.readFile(joinPath(uri, 'pyvenv.cfg'), { limits: { size: 64 * 1024 } })).value.toString();
		} catch {
			return undefined;
		}

		const [python, posix, fish, ...powershell] = await Promise.all(['python', 'activate', 'activate.fish', ...POWERSHELL_SCRIPTS].map(name => this._fileService.exists(joinPath(uri, 'bin', name))));
		const activationScripts: IActivationScripts = { posix, fish, powershell: POWERSHELL_SCRIPTS.find((_, index) => powershell[index]) };
		if (!python || (!posix && !fish && !activationScripts.powershell)) {
			return INCOMPLETE;
		}

		return { uri, relativePath: segments.join('/'), version: getPythonVersion(pyvenvConfig), activationScripts };
	}

	private _getLabel(uri: URI): string {
		return this._labelService.getUriLabel(uri, { relative: true });
	}
}
