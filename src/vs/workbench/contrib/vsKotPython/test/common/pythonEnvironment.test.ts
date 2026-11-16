/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getActivationVariables, getEnvironmentCandidates, getPythonVersion } from '../../common/pythonEnvironment.js';

suite('vs-kot Python environment', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('where environments are looked for, which version they have and how terminals activate them', () => {
		const folder = (name: string) => ({ name, isDirectory: true });
		const file = (name: string) => ({ name, isDirectory: false });

		assert.deepStrictEqual({
			project: getEnvironmentCandidates([file('pyproject.toml'), folder('src'), folder('.venv'), folder('venv'), folder('.git'), folder('node_modules'), folder('__pycache__')]),
			severalProjects: getEnvironmentCandidates([folder('worker'), folder('api'), folder('.claude')]),
			pythonVenv: getPythonVersion('home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.11.9\nexecutable = /usr/bin/python3.11\n'),
			uv: getPythonVersion('home = /opt/python/bin\r\nimplementation = CPython\r\nuv = 0.9.2\r\nversion_info = 3.12.4\r\ninclude-system-site-packages = false\r\n'),
			noVersion: getPythonVersion('home = /usr/bin\n'),
			allShells: getActivationVariables('/work/app/.venv', { posix: true, fish: true, powershell: 'Activate.ps1' }),
			quotes: getActivationVariables(`/work/it's Bob’s/.venv`, { posix: true, fish: true, powershell: 'activate.ps1' }),
			noScripts: getActivationVariables('/work/app/.venv', { posix: false, fish: false, powershell: undefined })
		}, {
			project: [['.venv'], ['venv'], ['src'], ['src', '.venv'], ['src', 'venv']],
			severalProjects: [['.claude'], ['api'], ['worker'], ['api', '.venv'], ['api', 'venv'], ['worker', '.venv'], ['worker', 'venv']],
			pythonVenv: '3.11.9',
			uv: '3.12.4',
			noVersion: undefined,
			allShells: [
				['VSCODE_PYTHON_ZSH_ACTIVATE', `if [ -f '/work/app/.venv/bin/activate' ]; then source '/work/app/.venv/bin/activate'; fi`],
				['VSCODE_PYTHON_BASH_ACTIVATE', `if [ -f '/work/app/.venv/bin/activate' ]; then source '/work/app/.venv/bin/activate'; fi`],
				['VSCODE_PYTHON_FISH_ACTIVATE', `if test -f '/work/app/.venv/bin/activate.fish'; source '/work/app/.venv/bin/activate.fish'; end`],
				['VSCODE_PYTHON_PWSH_ACTIVATE', `if (Test-Path -LiteralPath '/work/app/.venv/bin/Activate.ps1') { & '/work/app/.venv/bin/Activate.ps1' }`]
			],
			quotes: [
				['VSCODE_PYTHON_ZSH_ACTIVATE', `if [ -f '/work/it'\\''s Bob’s/.venv/bin/activate' ]; then source '/work/it'\\''s Bob’s/.venv/bin/activate'; fi`],
				['VSCODE_PYTHON_BASH_ACTIVATE', `if [ -f '/work/it'\\''s Bob’s/.venv/bin/activate' ]; then source '/work/it'\\''s Bob’s/.venv/bin/activate'; fi`],
				['VSCODE_PYTHON_FISH_ACTIVATE', `if test -f '/work/it\\'s Bob’s/.venv/bin/activate.fish'; source '/work/it\\'s Bob’s/.venv/bin/activate.fish'; end`],
				['VSCODE_PYTHON_PWSH_ACTIVATE', `if (Test-Path -LiteralPath '/work/it''s Bob’’s/.venv/bin/activate.ps1') { & '/work/it''s Bob’’s/.venv/bin/activate.ps1' }`]
			],
			noScripts: []
		});
	});
});
