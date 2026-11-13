/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: how much tab completion was used, as the Tab Completion view shows it.
//
// The extension `extensions/vs-kot-tab-completion` counts and keeps the numbers, on this computer only. It hands
// them over by running the command `ReportTabCompletionUsageCommandId` with an `ITabCompletionUsage`.

import { safeIntl } from '../../../../base/common/date.js';
import { language } from '../../../../base/common/platform.js';
import { isObject, isString } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';

/** Run by the extension to hand over its counts. */
export const ReportTabCompletionUsageCommandId = '_tabCompletion.reportUsage';

export interface ITabCompletionUsageCounts {
	/** Suggestions that appeared in the editor. */
	readonly shown: number;
	/** Suggestions that Tab took, in whole or in part. */
	readonly accepted: number;
	/** Lines that accepted suggestions wrote. */
	readonly lines: number;
	/** Characters that accepted suggestions wrote. */
	readonly characters: number;
}

export interface ITabCompletionUsage {
	/** The day the counting started, as YYYY-MM-DD. */
	readonly since: string;
	readonly today: ITabCompletionUsageCounts;
	/** The last seven days, today included. */
	readonly week: ITabCompletionUsageCounts;
	readonly total: ITabCompletionUsageCounts;
}

const DAY = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/;

function parseCounts(value: unknown): ITabCompletionUsageCounts | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const candidate = value as { [key in keyof ITabCompletionUsageCounts]?: unknown };
	const count = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? Math.floor(candidate) : undefined;
	const [shown, accepted, lines, characters] = [count(candidate.shown), count(candidate.accepted), count(candidate.lines), count(candidate.characters)];
	return shown === undefined || accepted === undefined || lines === undefined || characters === undefined ? undefined : { shown, accepted, lines, characters };
}

/**
 * Checks what an extension sent. Anything that is not a complete set of counts is dropped.
 */
export function parseTabCompletionUsage(value: unknown): ITabCompletionUsage | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const candidate = value as { [key in keyof ITabCompletionUsage]?: unknown };
	const [today, week, total] = [parseCounts(candidate.today), parseCounts(candidate.week), parseCounts(candidate.total)];
	if (!isString(candidate.since) || !DAY.test(candidate.since) || !today || !week || !total) {
		return undefined;
	}
	return { since: candidate.since, today, week, total };
}

const fullNumber = safeIntl.NumberFormat(language);
const shortNumber = safeIntl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 });

/** A count as the view shows it: in full while that is short, as 1.2M beyond. */
export function formatTabCompletionCount(count: number): string {
	return (count < 100_000 ? fullNumber : shortNumber).value.format(count);
}

/** The share of the shown suggestions that were accepted. A dash while none was shown. */
export function formatTabCompletionAcceptRate(counts: ITabCompletionUsageCounts): string {
	if (counts.shown === 0) {
		return '\u2013';
	}
	return localize('usage.percent', "{0}%", Math.round(Math.min(1, counts.accepted / counts.shown) * 100));
}

const mediumDate = safeIntl.DateTimeFormat(language, { dateStyle: 'medium' });

/** A day that came as YYYY-MM-DD, as a date in the user's language. */
export function formatTabCompletionDay(day: string): string {
	const parts = DAY.exec(day)?.groups;
	return parts ? mediumDate.value.format(new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day))) : day;
}
