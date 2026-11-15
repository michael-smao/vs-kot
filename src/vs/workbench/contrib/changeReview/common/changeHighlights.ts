/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { firstNonWhitespaceIndex, lastNonWhitespaceIndex } from '../../../../base/common/strings.js';
import { Range } from '../../../../editor/common/core/range.js';

/** A line counts as rewritten when the change touched more than this share of its text. */
const REWRITTEN_LINE_SHARE = 2 / 3;

/**
 * Takes the lines that a change rewrote for the most part out of the text that gets a highlight of its own. On
 * such a line the highlights are patches with a few words left out between them: they say no more than the color
 * of the line does, and make the line harder to read. A line with a small edit keeps its highlight.
 * @param ranges the text that a change touched inside its lines, on one side of the change. The ranges do not overlap.
 * @param getLineContent the text of a line on that side
 * @returns the ranges without the lines that they cover for the most part
 */
export function withoutRewrittenLines(ranges: readonly Range[], getLineContent: (lineNumber: number) => string): Range[] {
	// How much of each line the ranges cover. The white space around the text of a line is not counted.
	const lines = new Map<number, { readonly startColumn: number; readonly endColumn: number; covered: number }>();
	const getLine = (lineNumber: number) => {
		let line = lines.get(lineNumber);
		if (!line) {
			const content = getLineContent(lineNumber);
			const first = firstNonWhitespaceIndex(content);
			line = first === -1
				? { startColumn: 1, endColumn: 1, covered: 0 }
				: { startColumn: first + 1, endColumn: lastNonWhitespaceIndex(content) + 2, covered: 0 };
			lines.set(lineNumber, line);
		}
		return line;
	};
	for (const range of ranges) {
		for (let lineNumber = range.startLineNumber; lineNumber <= range.endLineNumber; lineNumber++) {
			const line = getLine(lineNumber);
			const from = Math.max(line.startColumn, lineNumber === range.startLineNumber ? range.startColumn : 1);
			const to = lineNumber === range.endLineNumber ? Math.min(line.endColumn, range.endColumn) : line.endColumn;
			line.covered += Math.max(0, to - from);
		}
	}
	const isRewritten = (lineNumber: number) => {
		const line = getLine(lineNumber);
		return line.covered > (line.endColumn - line.startColumn) * REWRITTEN_LINE_SHARE;
	};

	const result: Range[] = [];
	for (const range of ranges) {
		let lineNumber = range.startLineNumber;
		while (lineNumber <= range.endLineNumber) {
			if (isRewritten(lineNumber)) {
				lineNumber++;
				continue;
			}
			const firstLineNumber = lineNumber;
			while (lineNumber <= range.endLineNumber && !isRewritten(lineNumber)) {
				lineNumber++;
			}
			// A part that stops before a rewritten line still reaches over the line break, as the range did
			const part = lineNumber > range.endLineNumber
				? new Range(firstLineNumber, firstLineNumber === range.startLineNumber ? range.startColumn : 1, range.endLineNumber, range.endColumn)
				: new Range(firstLineNumber, firstLineNumber === range.startLineNumber ? range.startColumn : 1, lineNumber, 1);
			if (!part.isEmpty()) {
				result.push(part);
			}
		}
	}
	return result;
}
