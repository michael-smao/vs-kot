/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyVsClaudeActivityBarDefaults } from '../../../browser/parts/vsClaudeActivityBar.js';

suite('vs-claude activity bar defaults', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a new profile gets Search and Explorer, with the other built-in views unpinned', () => {
		assert.deepStrictEqual(applyVsClaudeActivityBarDefaults([]), [
			{ id: 'workbench.view.search', pinned: true, visible: false, order: 0 },
			{ id: 'workbench.view.explorer', pinned: true, visible: false, order: 1 },
			{ id: 'workbench.view.scm', pinned: false, visible: false, order: 2 },
			{ id: 'workbench.view.debug', pinned: false, visible: false, order: 3 },
			{ id: 'workbench.view.extensions', pinned: false, visible: false, order: 4 },
		]);
	});

	test('an existing profile is reordered and keeps the icons its extensions added', () => {
		const stored = [
			{ id: 'workbench.view.explorer', pinned: true, visible: false, order: 0 },
			{ id: 'workbench.view.search', pinned: false, visible: false, order: 1 },
			{ id: 'workbench.view.scm', pinned: true, visible: false, order: 2 },
			{ id: 'workbench.view.debug', pinned: true, visible: false, order: 3 },
			{ id: 'workbench.view.extension.docker', pinned: true, visible: false },
			{ id: 'workbench.view.extensions', pinned: true, visible: false, order: 4 },
		];

		assert.deepStrictEqual(applyVsClaudeActivityBarDefaults(stored), [
			{ id: 'workbench.view.search', pinned: true, visible: false, order: 1 },
			{ id: 'workbench.view.explorer', pinned: true, visible: false, order: 0 },
			{ id: 'workbench.view.scm', pinned: false, visible: false, order: 2 },
			{ id: 'workbench.view.debug', pinned: false, visible: false, order: 3 },
			{ id: 'workbench.view.extension.docker', pinned: true, visible: false },
			{ id: 'workbench.view.extensions', pinned: false, visible: false, order: 4 },
		]);
	});
});
