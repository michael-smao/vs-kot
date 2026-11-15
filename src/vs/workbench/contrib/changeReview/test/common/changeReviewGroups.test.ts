/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';
import { LineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import { groupCloseChanges, MAX_UNCHANGED_LINES_INSIDE_CHANGE } from '../../common/changeReviewGroups.js';

suite('ChangeReviewGroups', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('changes that are a few unchanged lines apart are one change, those further apart are not', () => {
		/** A change that put `lineCount` lines in the place of as many, from a line of the file on. */
		const change = (startLineNumber: number, lineCount: number) => new LineRangeMapping(new LineRange(startLineNumber, startLineNumber + lineCount), new LineRange(startLineNumber, startLineNumber + lineCount));
		/** Lines that were removed above a line of the file. They take up no line of it. */
		const removal = (lineNumber: number) => new LineRangeMapping(new LineRange(lineNumber, lineNumber + 3), new LineRange(lineNumber, lineNumber));
		const groups = (...mappings: LineRangeMapping[]) => groupCloseChanges(mappings).map(group => group.map(mapping => mapping.modified.toString()));
		const farBelow20 = 20 + MAX_UNCHANGED_LINES_INSIDE_CHANGE + 1;

		assert.deepStrictEqual({
			none: groups(),
			oneLineBetween: groups(change(79, 2), change(82, 1)),
			sevenLinesBetween: groups(change(49, 2), change(58, 1)),
			asFarApartAsIsStillOne: groups(change(19, 1), change(farBelow20 - 1, 1)),
			oneLineFurther: groups(change(19, 1), change(farBelow20, 1)),
			// each one is close to the next, and so all of them are one, however far the first is from the last
			aChain: groups(change(1, 1), change(10, 1), change(19, 1), removal(28)),
			aRemovalBetween: groups(change(5, 1), removal(8), change(9, 1), change(100, 1), removal(105)),
		}, {
			none: [],
			oneLineBetween: [['[79,81)', '[82,83)']],
			sevenLinesBetween: [['[49,51)', '[58,59)']],
			asFarApartAsIsStillOne: [['[19,20)', `[${farBelow20 - 1},${farBelow20})`]],
			oneLineFurther: [['[19,20)'], [`[${farBelow20},${farBelow20 + 1})`]],
			aChain: [['[1,2)', '[10,11)', '[19,20)', '[28,28)']],
			aRemovalBetween: [['[5,6)', '[8,8)', '[9,10)'], ['[100,101)', '[105,105)']],
		});
	});
});
