/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: change review. Changes that are close to each other are decided about as one.

import { LineRangeMapping } from '../../../../editor/common/diff/rangeMapping.js';

/**
 * Two changes with this many unchanged lines between them, or fewer, are one change to the reviewer. They are
 * read in one look, and a decision about each of them would only be the same decision twice.
 */
export const MAX_UNCHANGED_LINES_INSIDE_CHANGE = 10;

/**
 * Puts the changes of a file together that are close to each other, to be decided about as one.
 * @param mappings the changes of a file, from top to bottom
 * @returns the same changes in the same order, each group being one change to the reviewer
 */
export function groupCloseChanges(mappings: readonly LineRangeMapping[]): LineRangeMapping[][] {
	const groups: LineRangeMapping[][] = [];
	let previous: LineRangeMapping | undefined;
	for (const mapping of mappings) {
		const group = groups.at(-1);
		if (group && previous && mapping.modified.startLineNumber - previous.modified.endLineNumberExclusive <= MAX_UNCHANGED_LINES_INSIDE_CHANGE) {
			group.push(mapping);
		} else {
			groups.push([mapping]);
		}
		previous = mapping;
	}
	return groups;
}
