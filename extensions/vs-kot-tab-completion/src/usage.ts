/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: counts how tab completion is used: how many suggestions appeared, how many of them Tab took, and how
// much code that wrote. Only numbers per day are kept, no code and no file names, and they stay on this computer
// in the storage of this extension. The workbench shows them in the Tab Completion view; its side of this is in
// src/vs/workbench/contrib/vsKotTabCompletion.

import * as vscode from 'vscode';
import { TabCompletionProvider } from './provider';

/** Offered by the workbench: takes an {@link IUsageReport}. */
const REPORT_COMMAND = '_tabCompletion.reportUsage';
/** Run by the workbench when the view is opened or refreshed. */
const REQUEST_COMMAND = '_tabCompletion.requestUsage';
/** Run by the workbench to start counting anew. */
const RESET_COMMAND = '_tabCompletion.resetUsage';

const STORAGE_KEY = 'tabCompletion.usage';
/** How many days are kept one by one. Older days are only part of the total. */
const DAYS_KEPT = 92;
/** While suggestions come and go, the counts are stored this often at most. */
const STORE_INTERVAL_MS = 2000;
/** And the workbench hears of them this often at most. */
const REPORT_INTERVAL_MS = 300;

/** What is counted. */
export interface IUsageCounts {
	/** Suggestions that appeared in the editor. */
	shown: number;
	/** Suggestions that Tab took, in whole or in part. */
	accepted: number;
	/** Lines that accepted suggestions wrote, a line that was only finished counting as one. */
	lines: number;
	/** Characters that accepted suggestions wrote. */
	characters: number;
}

/** What is stored. */
interface IUsageRecord {
	/** The day the counting started, as YYYY-MM-DD. */
	since: string;
	total: IUsageCounts;
	/** The last days, by their date as YYYY-MM-DD. */
	days: Record<string, IUsageCounts>;
}

/** The same shape as `ITabCompletionUsage` in the workbench. */
interface IUsageReport {
	readonly since: string;
	readonly today: IUsageCounts;
	/** The last seven days, today included. */
	readonly week: IUsageCounts;
	readonly total: IUsageCounts;
}

const COUNTED: readonly (keyof IUsageCounts)[] = ['shown', 'accepted', 'lines', 'characters'];

function noCounts(): IUsageCounts {
	return { shown: 0, accepted: 0, lines: 0, characters: 0 };
}

function addCounts(to: IUsageCounts, counts: Partial<IUsageCounts>): void {
	for (const name of COUNTED) {
		to[name] += counts[name] ?? 0;
	}
}

/** Takes over what is a count and leaves out the rest. */
function readCounts(value: unknown): IUsageCounts {
	const counts = noCounts();
	if (typeof value === 'object' && value !== null) {
		for (const name of COUNTED) {
			const count = (value as Partial<Record<keyof IUsageCounts, unknown>>)[name];
			if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
				counts[name] = Math.floor(count);
			}
		}
	}
	return counts;
}

/** A day in the time of this computer, as YYYY-MM-DD. */
function toDay(date: Date): string {
	const twoDigits = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads what was stored. Whatever is missing or damaged in it counts as nothing.
 * @param today the day the counting starts when nothing was stored yet
 */
function readRecord(value: unknown, today: string): IUsageRecord {
	const stored = typeof value === 'object' && value !== null ? value as { since?: unknown; total?: unknown; days?: unknown } : {};
	const days: Record<string, IUsageCounts> = {};
	if (typeof stored.days === 'object' && stored.days !== null) {
		for (const [day, counts] of Object.entries(stored.days)) {
			if (DAY.test(day)) {
				days[day] = readCounts(counts);
			}
		}
	}
	return { since: typeof stored.since === 'string' && DAY.test(stored.since) ? stored.since : today, total: readCounts(stored.total), days };
}

/** Adds counts to a day and to the total, and drops the days that are too long ago to be kept one by one. */
function addToRecord(record: IUsageRecord, day: string, counts: Partial<IUsageCounts>): void {
	addCounts(record.total, counts);
	addCounts(record.days[day] ??= noCounts(), counts);

	const kept = Object.keys(record.days).sort();
	for (const old of kept.slice(0, Math.max(0, kept.length - DAYS_KEPT))) {
		delete record.days[old];
	}
}

function summarize(record: IUsageRecord, now: Date): IUsageReport {
	const week = noCounts();
	for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
		addCounts(week, record.days[toDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo))] ?? {});
	}
	return { since: record.since, today: { ...noCounts(), ...record.days[toDay(now)] }, week, total: { ...record.total } };
}

/**
 * Keeps the counts and tells the workbench about them.
 *
 * Every window of the editor counts for itself and adds what it counted to the one stored record, which the
 * editor keeps in step between its windows.
 */
export class UsageStatistics implements vscode.Disposable {

	private readonly _disposables: vscode.Disposable[] = [];

	/** What was counted and is not stored yet, and the day it belongs to. */
	private _pending = noCounts();
	private _pendingDay = toDay(new Date());
	private _storeTimer: ReturnType<typeof setTimeout> | undefined;
	private _reportTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * @param _storage where the counts are kept: the storage that the editor gives this extension
	 */
	constructor(private readonly _storage: vscode.Memento) {
		this._disposables.push(
			vscode.commands.registerCommand(REQUEST_COMMAND, () => this._report()),
			vscode.commands.registerCommand(RESET_COMMAND, () => this._reset())
		);
		this._report();
	}

	dispose(): void {
		clearTimeout(this._reportTimer);
		this._store();
		for (const disposable of this._disposables) {
			disposable.dispose();
		}
	}

	add(counts: Partial<IUsageCounts>): void {
		const today = toDay(new Date());
		if (today !== this._pendingDay) {
			this._store(); // what was counted before midnight belongs to the day before
			this._pendingDay = today;
		}
		addCounts(this._pending, counts);

		this._storeTimer ??= setTimeout(() => this._store(), STORE_INTERVAL_MS);
		this._reportTimer ??= setTimeout(() => this._report(), REPORT_INTERVAL_MS);
	}

	/** Adds what this window counted to what is stored, which other windows may have added to meanwhile. */
	private _store(): void {
		clearTimeout(this._storeTimer);
		this._storeTimer = undefined;
		if (COUNTED.every(name => this._pending[name] === 0)) {
			return;
		}

		const record = readRecord(this._storage.get(STORAGE_KEY), this._pendingDay);
		addToRecord(record, this._pendingDay, this._pending);
		this._pending = noCounts();
		this._storage.update(STORAGE_KEY, record).then(undefined, () => undefined);
	}

	private _reset(): void {
		clearTimeout(this._storeTimer);
		this._storeTimer = undefined;
		this._pending = noCounts();
		this._storage.update(STORAGE_KEY, undefined).then(undefined, () => undefined);
		this._report();
	}

	private _report(): void {
		clearTimeout(this._reportTimer);
		this._reportTimer = undefined;

		const now = new Date();
		const record = readRecord(this._storage.get(STORAGE_KEY), toDay(now));
		addToRecord(record, this._pendingDay, this._pending);

		// An editor without the view has no such command, and nothing is lost then
		vscode.commands.executeCommand(REPORT_COMMAND, summarize(record, now)).then(undefined, () => undefined);
	}
}

/** Where a suggestion was offered, as offsets into its file. */
export interface IOffer {
	readonly uri: string;
	/** Where the text of the suggestion starts. That is before the cursor when it repeats what is typed already. */
	readonly start: number;
	readonly cursor: number;
	/** Up to where the suggestion replaces what stands right of the cursor. */
	readonly end: number;
	readonly text: string;
}

/** A suggestion the way its user sees it. While they type along with it, the editor is handed one item after the other for it. */
interface ISuggestion {
	readonly uri: string;
	/** Where the cursor was when it was offered last. */
	cursor: number;
	/** What of it was still to be written then. */
	rest: string;
	isShown: boolean;
	isAccepted: boolean;
}

interface IOfferedItem {
	readonly suggestion: ISuggestion;
	readonly text: string;
	/** How much of the text, from its start, stands in the file already. */
	written: number;
	/** How many characters right of the cursor the item replaces, once all of it is taken. */
	readonly replaced: number;
}

/**
 * Follows what the editor does with the items it was handed, and counts each suggestion once: an item that only
 * goes on with the suggestion before it, because its first characters were typed, is not a new suggestion.
 */
export class SuggestionCounter {

	private readonly _items = new WeakMap<object, IOfferedItem>();
	private _latest: ISuggestion | undefined;

	constructor(private readonly _count: (counts: Partial<IUsageCounts>) => void) { }

	/**
	 * @param item what the editor was handed, as it names it later
	 * @param getText reads the file, from one offset to another
	 */
	offer(item: object, offer: IOffer, getText: (from: number, to: number) => string): void {
		const rest = offer.text.slice(offer.cursor - offer.start);
		const latest = this._latest;
		const typed = latest && latest.uri === offer.uri ? offer.cursor - latest.cursor : -1;
		const goesOn = latest !== undefined && typed >= 0 && typed < latest.rest.length && latest.rest.slice(typed) === rest && getText(latest.cursor, offer.cursor) === latest.rest.slice(0, typed);

		const suggestion: ISuggestion = goesOn ? latest : { uri: offer.uri, cursor: offer.cursor, rest, isShown: false, isAccepted: false };
		suggestion.cursor = offer.cursor;
		suggestion.rest = rest;
		this._latest = suggestion;
		this._items.set(item, { suggestion, text: offer.text, written: offer.cursor - offer.start, replaced: offer.end - offer.cursor });
	}

	/** The item appeared in the editor. */
	show(item: object): void {
		const suggestion = this._items.get(item)?.suggestion;
		if (suggestion && !suggestion.isShown) {
			suggestion.isShown = true;
			this._count({ shown: 1 });
		}
	}

	/**
	 * The item was taken.
	 * @param upTo how much of its text stands in the file now, when only a part of it was taken
	 */
	accept(item: object, upTo?: number): void {
		const offered = this._items.get(item);
		if (!offered) {
			return;
		}
		const end = Math.min(upTo ?? offered.text.length, offered.text.length);
		const written = offered.text.slice(offered.written, end);
		if (!written) {
			return;
		}
		offered.written = end;

		const suggestion = offered.suggestion;
		this._count({
			shown: suggestion.isShown ? 0 : 1, // it was taken, so it was there
			accepted: suggestion.isAccepted ? 0 : 1,
			// The line the suggestion starts on is counted with its first part, every further line where it begins
			lines: written.split('\n').length - (suggestion.isAccepted ? 1 : 0),
			characters: Math.max(0, written.length - (upTo === undefined ? offered.replaced : 0))
		});
		suggestion.isShown = true;
		suggestion.isAccepted = true;
	}

	/**
	 * A part of the item came into the file without it being taken: an entry of the editor's own suggestion list
	 * was accepted, which the item started with.
	 * @param upTo how much of the item's text stands in the file now
	 */
	skip(item: object, upTo: number): void {
		const offered = this._items.get(item);
		if (offered) {
			offered.written = Math.max(offered.written, Math.min(upTo, offered.text.length));
		}
	}
}

/**
 * The provider of the suggestions, which also counts what becomes of them. For that it asks the editor to tell
 * what it does with a suggestion, which takes the API proposal `inlineCompletionsAdditions`.
 */
export class CountedTabCompletionProvider extends TabCompletionProvider {

	private readonly _counter: SuggestionCounter;

	constructor(usage: UsageStatistics, ...parameters: ConstructorParameters<typeof TabCompletionProvider>) {
		super(...parameters);
		this._counter = new SuggestionCounter(counts => usage.add(counts));
	}

	override async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | undefined> {
		const items = await super.provideInlineCompletionItems(document, position, context, token);
		for (const item of items ?? []) {
			if (typeof item.insertText === 'string' && item.range) {
				this._counter.offer(
					item,
					{ uri: document.uri.toString(), start: document.offsetAt(item.range.start), cursor: document.offsetAt(position), end: document.offsetAt(item.range.end), text: item.insertText },
					(from, to) => document.getText(new vscode.Range(document.positionAt(from), document.positionAt(to)))
				);
			}
		}
		return items;
	}

	handleDidShowCompletionItem(item: vscode.InlineCompletionItem): void {
		this._counter.show(item);
	}

	handleDidPartiallyAcceptCompletionItem(item: vscode.InlineCompletionItem, info: vscode.PartialAcceptInfo | number): void {
		if (typeof info === 'number') {
			return; // the editor tells twice, in an older form too
		}
		if (info.kind === vscode.PartialAcceptTriggerKind.Suggest) {
			this._counter.skip(item, info.acceptedLength);
		} else {
			this._counter.accept(item, info.acceptedLength);
		}
	}

	handleEndOfLifetime(item: vscode.InlineCompletionItem, reason: vscode.InlineCompletionEndOfLifeReason): void {
		if (reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Accepted) {
			this._counter.accept(item);
		}
	}
}
