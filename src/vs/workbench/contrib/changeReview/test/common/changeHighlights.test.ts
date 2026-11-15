/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { withoutRewrittenLines } from '../../common/changeHighlights.js';

suite('ChangeHighlights', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a line that a change rewrote for the most part loses its highlights, a line with a small edit keeps them', () => {
		const lines = [
			'    // Required for a trial lead; a system-house application may come without a website.',
			'    website_url: Joi.when("type", { is: "test", then: websiteUrl.required() }),',
			'    const name = first + last;',
			'    return name.trim();',
			'',
			'}',
		];
		const at = (lineNumber: number, text: string) => {
			const startColumn = lines[lineNumber - 1].indexOf(text) + 1;
			return new Range(lineNumber, startColumn, lineNumber, startColumn + text.length);
		};
		const highlights = (...ranges: Range[]) => withoutRewrittenLines(ranges, lineNumber => lines[lineNumber - 1]).map(range => range.toString());

		assert.deepStrictEqual({
			rewritten: highlights(at(1, 'Required'), at(1, 'trial lead; a system-house application may come'), at(1, 'a website')),
			smallEdit: highlights(at(2, 'Joi.when("type", { is: "test", then: '), at(2, ' }')),
			besideARewrittenLine: highlights(at(1, '// Required for a trial lead; a system-house application may come without a website.'), at(2, '.required()')),
			// the indentation of a line is not text that could have been left alone
			whiteSpaceAround: highlights(new Range(4, 1, 4, 23)),
			// a range over several lines keeps what is on the lines with a small edit, and the line break after them
			overSeveralLines: highlights(new Range(2, 71, 6, 1)),
			beforeARewrittenLine: highlights(new Range(2, 71, 4, 24)),
			emptyLine: highlights(new Range(5, 1, 6, 2)),
		}, {
			rewritten: [],
			smallEdit: ['[2,18 -> 2,55]', '[2,76 -> 2,78]'],
			besideARewrittenLine: ['[2,65 -> 2,76]'],
			whiteSpaceAround: [],
			overSeveralLines: ['[2,71 -> 3,1]', '[5,1 -> 6,1]'],
			beforeARewrittenLine: ['[2,71 -> 3,1]'],
			emptyLine: ['[5,1 -> 6,1]'],
		});
	});
});
