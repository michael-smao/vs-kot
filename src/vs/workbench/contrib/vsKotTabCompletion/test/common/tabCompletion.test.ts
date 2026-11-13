/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeTabCompletionStatus, ITabCompletionStatus, parseTabCompletionStatus, TabCompletionAction, TabCompletionHealth, TabCompletionState } from '../../common/tabCompletion.js';
import { formatTabCompletionAcceptRate, ITabCompletionUsage, parseTabCompletionUsage } from '../../common/tabCompletionUsage.js';

suite('vs-kot tab completion status', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ready: ITabCompletionStatus = { enabled: true, server: 'managed', state: 'ready', message: undefined, percent: undefined, endpoint: 'http://127.0.0.1:11535', model: 'qwen2.5-coder:7b', isModelAutomatic: true, installedModels: [] };

	test('each state has a colour and a first thing to do', () => {
		const summarize = (status: ITabCompletionStatus | undefined) => {
			const { health, busy, actions } = describeTabCompletionStatus(status);
			return [health, busy, actions[0]];
		};
		const states: TabCompletionState[] = ['unsupported', 'needsSetup', 'settingUp', 'starting', 'ready', 'stopped', 'failed', 'unreachable'];

		assert.deepStrictEqual({
			notHeardFromYet: summarize(undefined),
			switchedOff: summarize({ ...ready, enabled: false }),
			...Object.fromEntries(states.map(state => [state, summarize({ ...ready, state })]))
		}, {
			notHeardFromYet: [TabCompletionHealth.Neutral, true, undefined],
			switchedOff: [TabCompletionHealth.Neutral, false, TabCompletionAction.TurnOn],
			unsupported: [TabCompletionHealth.Problem, false, TabCompletionAction.OpenSettings],
			needsSetup: [TabCompletionHealth.Problem, false, TabCompletionAction.SetUp],
			settingUp: [TabCompletionHealth.Neutral, true, undefined],
			starting: [TabCompletionHealth.Neutral, true, TabCompletionAction.TurnOff],
			ready: [TabCompletionHealth.Good, false, TabCompletionAction.TurnOff],
			stopped: [TabCompletionHealth.Problem, false, TabCompletionAction.Start],
			failed: [TabCompletionHealth.Problem, false, TabCompletionAction.TryAgain],
			unreachable: [TabCompletionHealth.Problem, false, TabCompletionAction.OpenSettings],
		});
	});

	test('a report is taken over field by field, and an incomplete one is dropped', () => {
		assert.deepStrictEqual({
			complete: parseTabCompletionStatus({ ...ready, percent: 250, installedModels: [{ name: 'a', size: 5 }, { name: 'b', size: 'big' }, { size: 1 }, 'c'], somethingElse: true }),
			unknownState: parseTabCompletionStatus({ ...ready, state: 'asleep' }),
			noModel: parseTabCompletionStatus({ ...ready, model: undefined }),
			notAnObject: parseTabCompletionStatus('ready'),
		}, {
			complete: { ...ready, percent: 100, installedModels: [{ name: 'a', size: 5 }, { name: 'b', size: undefined }] },
			unknownState: undefined,
			noModel: undefined,
			notAnObject: undefined,
		});
	});
});

suite('vs-kot tab completion usage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const counts = { shown: 40, accepted: 10, lines: 12, characters: 300 };
	const usage: ITabCompletionUsage = { since: '2026-11-13', today: counts, week: counts, total: counts };

	test('counts are taken over whole, and anything incomplete is dropped', () => {
		assert.deepStrictEqual({
			complete: parseTabCompletionUsage({ ...usage, today: { ...counts, lines: 12.7, somethingElse: 1 }, somethingElse: true }),
			noDay: parseTabCompletionUsage({ ...usage, since: 'yesterday' }),
			countMissing: parseTabCompletionUsage({ ...usage, week: { shown: 1, accepted: 1, lines: 1 } }),
			negativeCount: parseTabCompletionUsage({ ...usage, total: { ...counts, shown: -1 } }),
			notAnObject: parseTabCompletionUsage(12),
		}, {
			complete: usage,
			noDay: undefined,
			countMissing: undefined,
			negativeCount: undefined,
			notAnObject: undefined,
		});
	});

	test('the accept rate is a share of what was shown', () => {
		assert.deepStrictEqual([
			formatTabCompletionAcceptRate(counts),
			formatTabCompletionAcceptRate({ ...counts, shown: 0, accepted: 0 }),
			formatTabCompletionAcceptRate({ ...counts, shown: 3, accepted: 5 }),
		], ['25%', '\u2013', '100%']);
	});
});
