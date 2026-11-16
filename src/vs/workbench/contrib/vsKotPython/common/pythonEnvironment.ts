/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the Python environment of the open folder. VS Kot looks for virtual environments (a folder with a
// `pyvenv.cfg`) among the open folder's own folders, whatever their name, and in `.venv` and `venv` one level below
// them. It asks whether to use one, and then activates it in every new terminal and hands its interpreter to the
// built-in linters. The choice is kept per folder on this Mac; nothing is written into the project. See
// browser/pythonEnvironmentService.ts.

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IPythonEnvironmentService = createDecorator<IPythonEnvironmentService>('vsKotPythonEnvironmentService');

/** The Python environment of the open folder, and the way to choose another one. */
export interface IPythonEnvironmentService {
	readonly _serviceBrand: undefined;

	/** The environment that is active in new terminals and for linting, if any. */
	readonly activeEnvironment: IPythonEnvironment | undefined;

	/** Lets the person choose an environment of the open folder, or none. */
	selectEnvironment(): Promise<void>;
}

/** The activation scripts that a virtual environment has, by shell. */
export interface IActivationScripts {
	/** `bin/activate`, for zsh and bash. */
	readonly posix: boolean;
	/** `bin/activate.fish`. */
	readonly fish: boolean;
	/** The name of the PowerShell script in `bin`: `Activate.ps1` (venv) or `activate.ps1` (uv, virtualenv). */
	readonly powershell: string | undefined;
}

/** A virtual environment found in the open folder. */
export interface IPythonEnvironment {
	/** The folder of the environment, the one that holds `pyvenv.cfg`. */
	readonly uri: URI;
	/** The environment's path relative to its workspace folder, with `/` between the parts, e.g. `backend/.venv`. */
	readonly relativePath: string;
	/** The Python version from `pyvenv.cfg`, e.g. `3.11.9`. */
	readonly version: string | undefined;
	readonly activationScripts: IActivationScripts;
}

/** A child of a workspace folder, as far as the search needs it. */
export interface IFolderChild {
	readonly name: string;
	readonly isDirectory: boolean;
}

/** The value kept in workspace storage when the person chose to use no environment in a folder. */
export const NO_PYTHON_ENVIRONMENT = 'none';

/** Folders that hold no environment worth offering, or that are too large to look into. */
const SKIPPED_FOLDERS = new Set(['node_modules', '__pycache__', 'site-packages', '.git', '.hg', '.svn', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache']);

/** The names an environment usually has inside a project, in the order they are preferred. */
const NESTED_ENVIRONMENT_NAMES = ['.venv', 'venv'];

/**
 * The folders that may be a virtual environment, as paths relative to the workspace folder: every child folder of
 * the workspace folder (an environment may have any name there), and `.venv` and `venv` in every child folder that
 * is not hidden, for a folder that holds several projects. Environments are never looked into. The order is the
 * order of preference: the workspace folder's own `.venv` and `venv` first, then its other folders, then those one
 * level below.
 */
export function getEnvironmentCandidates(children: readonly IFolderChild[]): string[][] {
	const folders = children.filter(child => child.isDirectory && !SKIPPED_FOLDERS.has(child.name)).map(child => child.name).sort(compareNames);

	const topLevel = folders.map(name => [name]);
	const nested = folders.filter(name => !name.startsWith('.') && !NESTED_ENVIRONMENT_NAMES.includes(name)).flatMap(name => NESTED_ENVIRONMENT_NAMES.map(environmentName => [name, environmentName]));

	return [...topLevel, ...nested];
}

/** Sorts `.venv` and `venv` before every other name, and the rest by name. */
function compareNames(a: string, b: string): number {
	const rankA = NESTED_ENVIRONMENT_NAMES.indexOf(a);
	const rankB = NESTED_ENVIRONMENT_NAMES.indexOf(b);
	if (rankA !== rankB) {
		return (rankA === -1 ? NESTED_ENVIRONMENT_NAMES.length : rankA) - (rankB === -1 ? NESTED_ENVIRONMENT_NAMES.length : rankB);
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The Python version from the content of a `pyvenv.cfg`. `python -m venv` writes `version`, uv writes
 * `version_info`.
 */
export function getPythonVersion(pyvenvConfig: string): string | undefined {
	const values = new Map<string, string>();
	for (const line of pyvenvConfig.split(/\r?\n/)) {
		const match = /^\s*(?<key>[^=\s]+)\s*=\s*(?<value>.*?)\s*$/.exec(line);
		if (match?.groups) {
			values.set(match.groups.key.toLowerCase(), match.groups.value);
		}
	}
	return values.get('version') || values.get('version_info') || undefined;
}

/**
 * The variables that make the shell integration of zsh, bash, fish and PowerShell run an environment's own
 * activation script once the shell has started, after the person's rc files. That gives the same result as typing
 * `source .venv/bin/activate`: the prompt shows the environment, `deactivate` works, and a `pyenv init` in
 * `~/.zshrc` cannot put its own `python` in front again. A shell without the shell integration stays as it is.
 *
 * Each command first checks that the script is still there: a terminal that comes back after a restart gets the
 * command before VS Kot has looked at the folder again, and an environment deleted in the meantime must not make
 * the shell integration report a failed activation.
 */
export function getActivationVariables(environmentPath: string, scripts: IActivationScripts): [variable: string, value: string][] {
	const result: [string, string][] = [];
	if (scripts.posix) {
		const script = quoteForPosixShell(`${environmentPath}/bin/activate`);
		const command = `if [ -f ${script} ]; then source ${script}; fi`;
		result.push(['VSCODE_PYTHON_ZSH_ACTIVATE', command], ['VSCODE_PYTHON_BASH_ACTIVATE', command]);
	}
	if (scripts.fish) {
		const script = quoteForFish(`${environmentPath}/bin/activate.fish`);
		result.push(['VSCODE_PYTHON_FISH_ACTIVATE', `if test -f ${script}; source ${script}; end`]);
	}
	if (scripts.powershell) {
		const script = quoteForPowerShell(`${environmentPath}/bin/${scripts.powershell}`);
		result.push(['VSCODE_PYTHON_PWSH_ACTIVATE', `if (Test-Path -LiteralPath ${script}) { & ${script} }`]);
	}
	return result;
}

/** Quotes a value for sh, bash and zsh: single quotes, with each single quote written as `'\''`, so nothing in it is expanded. */
function quoteForPosixShell(value: string): string {
	return `'${value.replaceAll(`'`, `'\\''`)}'`;
}

/** Quotes a value for fish: single quotes, in which fish only knows `\\` and `\'` as escapes. */
function quoteForFish(value: string): string {
	return `'${value.replaceAll('\\', '\\\\').replaceAll(`'`, `\\'`)}'`;
}

/**
 * Quotes a value for PowerShell: a verbatim string in single quotes, with each single quote doubled. PowerShell also
 * ends such a string at a typographic single quote (U+2018 to U+201B), so those are doubled too.
 */
function quoteForPowerShell(value: string): string {
	return `'${value.replace(/['‘’‚‛]/g, quote => quote + quote)}'`;
}
