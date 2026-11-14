/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: which changes Claude Code made.
//
// The change review shows everything that reaches a file from outside the editor. Whether that was Claude Code it
// cannot see in the file. Claude Code can say so itself: it runs a hook after each of its edits and shell commands
// and hands it what the tool did. Once connected, that hook is a small script that stores what it is handed. The
// editor turns each stored tool call into one entry per changed file, and a change under review whose lines are in
// such an entry is marked as Claude's.
//
// The record only ever adds to what the review knows. A change without an entry is not known to be someone else's:
// a session in the cloud, a coworker's computer or a hook that is switched off leave no entry either.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { stringHash } from '../../../../base/common/hash.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { FormattingOptions } from '../../../../base/common/jsonFormatter.js';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const CLAUDE_SETTINGS_FILE_SETTING = 'changeReview.claudeCode.settingsFile';
export const CLAUDE_RECORD_FOLDER_SETTING = 'changeReview.claudeCode.recordFolder';

// --- the record

/** One file that one tool call of Claude Code changed. */
export interface IClaudeRecordEntry {
	/** The file as Claude Code names it: an absolute path. */
	readonly path: string;
	/** When the tool call was done, in milliseconds since 1970. */
	readonly time: number;
	readonly session: string;
	/** The tool that made the change, such as `Edit`, `Write` or `Bash`. */
	readonly tool: string;
	/** The lines the tool call wrote and the lines it took away, each as {@link hashClaudeLine} has it. */
	readonly added: readonly number[];
	readonly removed: readonly number[];
	/** Set when the file is known to have been changed, but not in which lines. */
	readonly isWithoutLines?: boolean;
}

type JsonObject = { readonly [key: string]: unknown };

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] {
	return Array.isArray(value) ? value : [];
}

function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

/**
 * What a line is compared by: its text without the white space around it, so that a line is still known after it
 * was indented anew. An empty line says nothing about who wrote it and has no hash.
 */
export function hashClaudeLine(line: string): number | undefined {
	const text = line.trim();
	return text.length > 0 ? stringHash(text, 0) : undefined;
}

function hashLines(lines: readonly string[]): Set<number> {
	const hashes = new Set<number>();
	for (const line of lines) {
		const lineHash = hashClaudeLine(line);
		if (lineHash !== undefined) {
			hashes.add(lineHash);
		}
	}
	return hashes;
}

type ILineChanges = Pick<IClaudeRecordEntry, 'added' | 'removed' | 'isWithoutLines'>;

const WITHOUT_LINES: ILineChanges = { added: [], removed: [], isWithoutLines: true };

/** What it changes to put one text in the place of another. Lines that are in both were there before. */
function getReplacement(oldLines: readonly string[], newLines: readonly string[]): ILineChanges {
	const oldHashes = hashLines(oldLines);
	const newHashes = hashLines(newLines);
	let added = [...newHashes].filter(lineHash => !oldHashes.has(lineHash));
	const removed = [...oldHashes].filter(lineHash => !newHashes.has(lineHash));
	if (added.length === 0 && removed.length === 0) {
		added = [...newHashes]; // only the white space changed: the new lines are still what was written
	}
	return added.length > 0 || removed.length > 0 ? { added, removed } : WITHOUT_LINES;
}

/** Reads hunks as Claude Code reports them: each has `lines`, and a line starts with `+`, `-` or a space. */
function getPatchChanges(hunks: unknown): ILineChanges | undefined {
	const added: string[] = [];
	const removed: string[] = [];
	for (const hunk of asArray(hunks)) {
		for (const line of asArray(asObject(hunk)?.lines)) {
			if (typeof line !== 'string') {
				continue;
			}
			if (line.startsWith('+')) {
				added.push(line.substring(1));
			} else if (line.startsWith('-')) {
				removed.push(line.substring(1));
			}
		}
	}

	const changes = { added: [...hashLines(added)], removed: [...hashLines(removed)] };
	return changes.added.length > 0 || changes.removed.length > 0 ? changes : undefined;
}

/**
 * Turns what Claude Code hands to a hook after a tool call into one entry per file that the tool call changed.
 *
 * Only `tool_input` is documented for the file tools. What the tool answered is used where it is there, and
 * nothing depends on it. A shell command says which files it changed in `tool_response.bashEditDiff`.
 * @param time when the tool call was done
 * @returns no entry when the tool call changed no file, or when its input is not understood
 */
export function digestClaudeHookInput(input: unknown, time: number): IClaudeRecordEntry[] {
	const event = asObject(input);
	const tool = asString(event?.tool_name);
	if (!event || !tool) {
		return [];
	}

	const session = asString(event.session_id) ?? '';
	const cwd = asString(event.cwd);
	const toolInput = asObject(event.tool_input);
	const toolResponse = asObject(event.tool_response);
	const toEntry = (path: string, changes: ILineChanges): IClaudeRecordEntry => ({
		path: isAbsolute(path) || !cwd ? path : join(cwd, path),
		time,
		session,
		tool,
		...changes
	});

	switch (tool) {
		case 'Edit':
		case 'MultiEdit': {
			const path = asString(toolInput?.file_path);
			if (!path) {
				return [];
			}
			const edits = tool === 'MultiEdit' ? asArray(toolInput?.edits).map(asObject) : [toolInput];
			const oldLines = edits.flatMap(edit => splitLines(asString(edit?.old_string) ?? ''));
			const newLines = edits.flatMap(edit => splitLines(asString(edit?.new_string) ?? ''));
			// The tool is asked to replace a text, and that is often a part of a line. A change is known again by
			// its whole lines: those are in what the tool answered, where it says which lines it changed.
			return [toEntry(path, getPatchChanges(toolResponse?.structuredPatch) ?? getReplacement(oldLines, newLines))];
		}
		case 'Write': {
			const path = asString(toolInput?.file_path);
			const content = asString(toolInput?.content);
			if (!path || content === undefined) {
				return [];
			}
			const original = asString(toolResponse?.originalFile);
			return [toEntry(path, getPatchChanges(toolResponse?.structuredPatch) ?? getReplacement(original !== undefined ? splitLines(original) : [], splitLines(content)))];
		}
		case 'NotebookEdit': {
			// A notebook is stored as JSON, in which the lines of a cell are not the lines of the file
			const path = asString(toolInput?.notebook_path);
			return path ? [toEntry(path, WITHOUT_LINES)] : [];
		}
		case 'Bash': {
			const diff = asObject(toolResponse?.bashEditDiff);
			const entries: IClaudeRecordEntry[] = [];
			const paths = new Set<string>();
			for (const file of asArray(diff?.files).map(asObject)) {
				const path = asString(file?.filePath);
				if (path && !paths.has(path)) {
					paths.add(path);
					entries.push(toEntry(path, getPatchChanges(file?.hunks) ?? WITHOUT_LINES));
				}
			}
			// A command that changed many files only says for some of them what it changed
			for (const path of asArray(diff?.changedFiles)) {
				if (typeof path === 'string' && !paths.has(path)) {
					paths.add(path);
					entries.push(toEntry(path, WITHOUT_LINES));
				}
			}
			return entries;
		}
	}

	return [];
}

/** Reads an entry as it is stored. */
export function parseClaudeRecordEntry(text: string): IClaudeRecordEntry | undefined {
	let value: JsonObject | undefined;
	try {
		value = asObject(JSON.parse(text));
	} catch {
		return undefined;
	}

	const path = asString(value?.path);
	const time = value?.time;
	if (!value || !path || typeof time !== 'number') {
		return undefined;
	}

	const toHashes = (hashes: unknown) => asArray(hashes).filter((lineHash): lineHash is number => typeof lineHash === 'number');
	return {
		path,
		time,
		session: asString(value.session) ?? '',
		tool: asString(value.tool) ?? '',
		added: toHashes(value.added),
		removed: toHashes(value.removed),
		...(value.isWithoutLines === true ? { isWithoutLines: true } : {})
	};
}

/** A line that only closes a bracket is the same wherever it stands. It decides nothing while other lines can. */
const SIGNIFICANT_LINE = /[\p{L}\p{N}]/u;

/**
 * Says whether Claude Code made a change, going by the lines the change added to a file and those it removed.
 *
 * It did when at least half of the added lines are lines that Claude Code wrote into this file. A change that only
 * removes lines is judged by those. The other half may be what a formatter or the reviewer did to the lines since.
 * @param entries what is on record for the file, in any order
 * @returns the latest entry that says so, or `undefined` when nothing on record says so
 */
export function findClaudeEntry(entries: readonly IClaudeRecordEntry[], addedLines: readonly string[], removedLines: readonly string[]): IClaudeRecordEntry | undefined {
	if (entries.length === 0) {
		return undefined;
	}

	const hasAddedLines = addedLines.some(line => line.trim().length > 0);
	const lines = hasAddedLines ? addedLines : removedLines;
	const significantLines = lines.filter(line => SIGNIFICANT_LINE.test(line));
	const hashes = hashLines(significantLines.length > 0 ? significantLines : lines);

	let latest: IClaudeRecordEntry | undefined;
	if (hashes.size > 0) {
		const matched = new Set<number>();
		for (const entry of entries) {
			let isMatch = false;
			for (const lineHash of hasAddedLines ? entry.added : entry.removed) {
				if (hashes.has(lineHash)) {
					matched.add(lineHash);
					isMatch = true;
				}
			}
			if (isMatch && (!latest || entry.time > latest.time)) {
				latest = entry;
			}
		}
		if (matched.size * 2 >= hashes.size) {
			return latest;
		}
	}

	// Nothing says which lines: then it is enough that Claude Code changed the file at all
	latest = undefined;
	for (const entry of entries) {
		if (entry.isWithoutLines && (!latest || entry.time > latest.time)) {
			latest = entry;
		}
	}
	return latest;
}

// --- what Claude Code staged or committed
//
// What is staged counts as reviewed: approving a change stages it. That only holds for what the reviewer staged.
// Claude Code stages and commits too, and what it staged was not looked at by anyone. So the script notes the
// staged version of every file before a shell command of Claude Code and compares after it. A file whose staged
// version took in what was in the working tree stays under review, against the version that was staged before.

/** What the script stores when a shell command of Claude Code changed what is staged in a repository. */
export interface IClaudeGitEvent {
	/** The root folder of the repository. */
	readonly repository: string;
	/** When the command started and ended, in milliseconds since 1970. */
	readonly start: number;
	readonly end: number;
	readonly session: string;
	/** The commit that was checked out before the command and after it. `undefined` in a repository without commits. */
	readonly headBefore: string | undefined;
	readonly headAfter: string | undefined;
	/** When each commit was made that is in the history now and was not before, in seconds since 1970. */
	readonly commitTimes: readonly number[];
	/** The files that differ from their staged version after the command, by their path in the repository. */
	readonly unstaged: ReadonlySet<string>;
	/** The files whose staged version differs from the commit that is checked out after the command. */
	readonly staged: ReadonlySet<string>;
	/** The staged version of each file whose entry changed, as the id of its blob, before the command and after it. */
	readonly before: ReadonlyMap<string, string>;
	readonly after: ReadonlyMap<string, string>;
}

/** One file whose staged version Claude Code changed to what was in the working tree. */
export interface IClaudeStaging {
	/** The file, as an absolute path. */
	readonly path: string;
	readonly repository: string;
	/** When the command that staged it started and ended. */
	readonly start: number;
	readonly time: number;
	readonly session: string;
	/** The blob that was staged before the command. `undefined` when git had no version of the file. */
	readonly before: string | undefined;
	/** The blob that is staged after it. `undefined` when the file was removed from git. */
	readonly after: string | undefined;
	/** Whether the command also committed it. */
	readonly isCommitted: boolean;
	readonly headBefore: string | undefined;
}

/** Git writes a path with unusual characters in quotes, with those characters escaped the way C does it. */
function unquoteGitPath(path: string): string {
	if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) {
		return path;
	}

	// An escape stands for one byte, and a character can be several of them
	const simple: { readonly [character: string]: number } = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
	const bytes: number[] = [];
	const escape = /\\(?:(?<octal>[0-7]{3})|(?<character>.))/g;
	const text = path.substring(1, path.length - 1);
	let end = 0;
	for (let match = escape.exec(text); match; match = escape.exec(text)) {
		bytes.push(...VSBuffer.fromString(text.substring(end, match.index)).buffer);
		const { octal, character } = match.groups!;
		bytes.push(octal !== undefined ? parseInt(octal, 8) : simple[character] ?? character.charCodeAt(0));
		end = match.index + match[0].length;
	}
	bytes.push(...VSBuffer.fromString(text.substring(end)).buffer);
	return VSBuffer.wrap(new Uint8Array(bytes)).toString();
}

/** Reads what the script stored. See {@link CLAUDE_HOOK_SCRIPT} for how it is written. */
export function parseClaudeGitEvent(text: string): IClaudeGitEvent | undefined {
	const lines = splitLines(text);
	if (lines[0] !== 'vs-kot git 1') {
		return undefined;
	}

	const values = new Map<string, string>();
	const unstaged = new Set<string>();
	const staged = new Set<string>();
	const before = new Map<string, string>();
	const after = new Map<string, string>();
	// A file in a merge conflict has several entries. What is reviewed in it is decided when the conflict is.
	const inConflict = new Set<string>();

	let section: string | undefined;
	for (const line of lines.slice(1)) {
		if (line.length === 0) {
			continue;
		}
		if (/^\[[a-z]+\]$/.test(line)) {
			section = line;
		} else if (section === undefined) {
			const separator = line.indexOf(' ');
			values.set(separator === -1 ? line : line.substring(0, separator), separator === -1 ? '' : line.substring(separator + 1));
		} else if (section === '[unstaged]') {
			unstaged.add(unquoteGitPath(line));
		} else if (section === '[staged]') {
			staged.add(unquoteGitPath(line));
		} else if (section === '[index]') {
			const entry = /^(?<side>[<>]) (?<mode>\d+) (?<object>[0-9a-f]+) (?<stage>\d)\t(?<path>.*)$/.exec(line)?.groups;
			if (!entry) {
				continue;
			}
			const path = unquoteGitPath(entry.path);
			if (entry.stage !== '0') {
				inConflict.add(path);
			} else if (entry.mode.startsWith('100')) { // a file, not a link or another repository
				(entry.side === '<' ? before : after).set(path, entry.object);
			}
		}
	}

	for (const path of inConflict) {
		before.delete(path);
		after.delete(path);
	}

	const repository = values.get('top');
	const [start, end] = (values.get('time') ?? '').split(' ').map(Number);
	const [headBefore, headAfter] = (values.get('head') ?? '').split(' ').map(head => head && head !== 'none' ? head : undefined);
	if (!repository || !Number.isFinite(start) || !Number.isFinite(end)) {
		return undefined;
	}

	return {
		repository,
		start: start * 1000,
		end: end * 1000,
		session: values.get('session') ?? '',
		headBefore,
		headAfter,
		commitTimes: (values.get('commits') ?? '').split(' ').filter(time => time.length > 0).map(Number).filter(Number.isFinite),
		unstaged,
		staged,
		before,
		after
	};
}

/**
 * Says which files a shell command of Claude Code staged or committed from the working tree.
 *
 * The staged version of a file also changes when Claude Code switches to another branch, pulls or rebases. What
 * comes in that way was committed before and is not under review. It is told apart by the commits: after a commit
 * of Claude Code, every commit that is new to the history was made while the command ran.
 */
export function getClaudeStagings(event: IClaudeGitEvent): IClaudeStaging[] {
	const hasMoved = event.headBefore !== event.headAfter;
	const hasCommitted = hasMoved && event.headAfter !== undefined && event.commitTimes.length > 0
		&& event.commitTimes.every(time => time * 1000 >= event.start);
	if (hasMoved && !hasCommitted) {
		return []; // the history that is checked out was made elsewhere
	}

	const stagings: IClaudeStaging[] = [];
	for (const path of new Set([...event.before.keys(), ...event.after.keys()])) {
		const before = event.before.get(path);
		const after = event.after.get(path);
		if (before === after) {
			continue; // only its mode changed
		}

		// The staged version is the file as it is in the working tree, or it is what was committed. Otherwise
		// something was unstaged, or only a part was staged: that is taken as it is, the way it always was.
		const isCommitted = hasCommitted && !event.staged.has(path);
		if (event.unstaged.has(path) && !isCommitted) {
			continue;
		}

		stagings.push({
			path: join(event.repository, path),
			repository: event.repository,
			start: event.start,
			time: event.end,
			session: event.session,
			before,
			after,
			isCommitted,
			headBefore: event.headBefore
		});
	}
	return stagings;
}

/**
 * A file that stays under review although git has its changes staged or committed: Claude Code staged them, not
 * the reviewer. It is stored as it is here, one per file.
 */
export interface IClaudeHold {
	readonly path: string;
	readonly repository: string;
	/** The blob of the version the reviewer last agreed to. `null` when they never saw a version: the file is new. */
	readonly reviewed: string | null;
	/**
	 * The blob the file was held against at first, once the reviewer agreed to more than that. A blob that is
	 * written for an approval is in no commit, and git clears such blobs away after some weeks: the file is then
	 * held against this one again.
	 */
	readonly original?: string;
	/** The blob that Claude Code last staged. `null` when it removed the file from git. */
	readonly staged: string | null;
	/** When Claude Code first staged the file without a review, and when it last did. */
	readonly since: number;
	readonly time: number;
	readonly session: string;
	readonly isCommitted: boolean;
	/** The commit that was checked out before Claude Code first staged the file. It has the file as it was then. */
	readonly headBefore: string | null;
	/** The commands that are taken into account, by the name of what the script stored for them. */
	readonly events: readonly string[];
	/** When the reviewer was done with the file. It is kept so that a command from before is not taken up again. */
	readonly released?: number;
}

const MAX_HOLD_EVENTS = 64;

/** What the reviewer last staged themselves in a file, by approving a change or by saving what they wrote. */
export interface IOwnStaging {
	readonly blob: string;
	readonly time: number;
}

/**
 * Takes what Claude Code staged in a file into what is known about that file.
 * @param hold what is stored for the file, if anything
 * @param event the name of what the script stored for the command
 * @param own what the reviewer last staged in the file themselves. An approval that is staged while a command
 * of Claude Code runs is in what that command is seen to have changed, and is not Claude's.
 * @returns what to store for the file now, or `undefined` when nothing changes
 */
export function applyClaudeStaging(hold: IClaudeHold | undefined, staging: IClaudeStaging, event: string, own: IOwnStaging | undefined): IClaudeHold | undefined {
	if (hold?.events.includes(event)) {
		return undefined;
	}

	const events = [...(hold?.events ?? []), event].slice(-MAX_HOLD_EVENTS);
	const staged = staging.after ?? null;

	if (hold && hold.released === undefined) {
		// Under review already: what the reviewer agreed to is what it was
		const isLatest = staging.time >= hold.time;
		return { ...hold, staged: isLatest ? staged : hold.staged, time: Math.max(hold.time, staging.time), isCommitted: hold.isCommitted || staging.isCommitted, events };
	}
	if (hold && hold.released !== undefined && staging.time <= hold.released) {
		return { ...hold, events }; // a command from before the reviewer was done with the file
	}

	// What is staged now is what the reviewer staged: Claude Code changed nothing about it
	const reviewed = own && own.time >= staging.start ? own.blob : staging.before ?? null;
	if (own?.blob === staged || reviewed === staged) {
		return hold ? { ...hold, events } : undefined;
	}

	return {
		path: staging.path,
		repository: staging.repository,
		reviewed,
		staged,
		since: staging.time,
		time: staging.time,
		session: staging.session,
		isCommitted: staging.isCommitted,
		headBefore: staging.headBefore ?? null,
		events
	};
}

/** Reads what is stored for a file that is, or was, under review although its changes are staged. */
export function parseClaudeHold(text: string): IClaudeHold | undefined {
	let value: JsonObject | undefined;
	try {
		value = asObject(JSON.parse(text));
	} catch {
		return undefined;
	}

	const path = asString(value?.path);
	const repository = asString(value?.repository);
	const { since, time, released } = value ?? {};
	if (!value || !path || !repository || typeof since !== 'number' || typeof time !== 'number') {
		return undefined;
	}

	return {
		path,
		repository,
		reviewed: asString(value.reviewed) ?? null,
		staged: asString(value.staged) ?? null,
		since,
		time,
		session: asString(value.session) ?? '',
		isCommitted: value.isCommitted === true,
		headBefore: asString(value.headBefore) ?? null,
		events: asArray(value.events).filter((event): event is string => typeof event === 'string'),
		...(typeof value.original === 'string' ? { original: value.original } : {}),
		...(typeof released === 'number' ? { released } : {})
	};
}

/** Reads what is stored about the reviewer's own staging of a file. */
export function parseOwnStaging(text: string): IOwnStaging | undefined {
	let value: JsonObject | undefined;
	try {
		value = asObject(JSON.parse(text));
	} catch {
		return undefined;
	}
	const blob = asString(value?.blob);
	const time = value?.time;
	return blob && typeof time === 'number' ? { blob, time } : undefined;
}

// --- the hook

/** Ends the commands that the connection adds to the settings of Claude Code. The shell reads it as a comment. */
const HOOK_MARKER = '# vs-kot change review';

/** Raised with every change to {@link CLAUDE_HOOK_SCRIPT}. */
const HOOK_VERSION = 2;
/**
 * How many tool calls the script keeps for an editor to read. An editor that is open takes them away as they come.
 * The limit is for a computer on which Claude Code is connected and this editor is not used anymore: what the
 * script keeps holds whole files, and must not pile up there without end.
 */
const MAX_WAITING_EVENTS = 2000;
/** The same for what the script keeps about staging. That is small, and there is little of it. */
const MAX_WAITING_GIT_EVENTS = 500;
/** How many repositories the script looks at for one shell command. */
const MAX_REPOSITORIES = 8;
/** No shell command of Claude Code runs for longer than ten minutes. What was noted before one is of no use after that. */
const SNAPSHOT_KEPT_MINUTES = 15;
/** What git calls a folder without any file. A repository without a commit is compared with it. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Whether a stored script is the one to keep. The installed editor and one run from source share the script, and
 * so do an editor and the update it is about to get: the newest of them decides, and an older one leaves it alone.
 */
export function isCurrentClaudeHookScript(stored: string | undefined): boolean {
	if (stored === undefined) {
		return false;
	}
	const version = /^# vs-kot change review, hook version (?<version>\d+):/m.exec(stored)?.groups?.version;
	return stored === CLAUDE_HOOK_SCRIPT || (version !== undefined && Number(version) > HOOK_VERSION);
}

/**
 * The script that Claude Code runs before a shell command and after a tool call. It is handed what the tool does
 * on its standard input and keeps that in the folder it is in, for the editor to read. It never fails, and it does
 * not keep a tool call waiting for longer than it takes to write a file, or to list what is staged.
 *
 * What it stores about staging is text, in lines. The first lines are a name and a value each: `top` the folder of
 * the repository, `time` when the command started and ended, `head` the commit before and after, `session`, and
 * `commits` when the commits were made that are new to the history. Then come three lists: `[unstaged]` the files
 * that differ from their staged version, `[staged]` the files whose staged version differs from the commit, and
 * `[index]` the entries of staged files that are not what they were, `<` as before and `>` as after.
 */
export const CLAUDE_HOOK_SCRIPT = [
	'#!/bin/sh',
	`# vs-kot change review, hook version ${HOOK_VERSION}: notes which files Claude Code changed, and what it staged or committed.`,
	'#',
	'# Claude Code runs this before each of its shell commands and after each of its edits and shell commands (see',
	'# "hooks" in its settings.json) and hands over what the tool does. That is kept next to this script for vs-kot',
	'# to read, and it stays on this computer. vs-kot writes this file anew when it starts: a change made here does',
	'# not last.',
	'umask 077',
	'dir=${0%/*}',
	'kind=$1',
	'input=',
	'case $kind in before|shell) input=$(cat) ;; esac',
	'# One value of what Claude Code handed over: the text in the quotes after its name',
	`field() { printf '%s' "$input" | LC_ALL=C sed -n 's/.*"'"$1"'":"\\([^"]*\\)".*/\\1/p' | sed -n 1p; }`,
	'# Git, asked about a repository without changing anything in it',
	'git_in() { top=$1; shift; GIT_OPTIONAL_LOCKS=0 git -c core.quotePath=false -C "$top" "$@"; }',
	'',
	'if [ "$kind" = before ]; then',
	'\t# Before a shell command, the staged version of every file is noted, to see after it what the command staged.',
	'\t# Only a command that names git and one of its words for changing what is staged can do that, and only the',
	'\t# repositories that are open in vs-kot matter. Most commands end here.',
	`\tcase $input in *'"command"'*git*) ;; *) exit 0 ;; esac`,
	`\tcase $input in *add*|*commit*|*stage*|*' rm '*|*' mv '*|*apply*|*' am '*|*merge*|*rebase*|*cherry-pick*|*revert*|*reset*|*restore*|*stash*|*checkout*|*switch*|*pull*|*update-index*) ;; *) exit 0 ;; esac`,
	'\tset -- "$dir"/repos/*',
	'\t[ -f "$1" ] || exit 0',
	'\tid=$(field tool_use_id)',
	`\tcase $id in ''|*[!A-Za-z0-9_-]*) exit 0 ;; esac`,
	`\tfind "$dir/pending" -mindepth 1 -maxdepth 1 -mmin +${SNAPSHOT_KEPT_MINUTES} -exec rm -rf {} + 2>/dev/null`,
	'\tsnap="$dir/pending/$id"',
	'\tmkdir -p "$snap" 2>/dev/null || exit 0',
	'\tdate +%s > "$snap/time"',
	'\tcwd=$(field cwd)',
	'\t# The repositories this command can reach: those it names, or that it runs in. When it names none, those in',
	'\t# the folder it runs in: a session that was started above its repositories goes into one with a relative path.',
	'\tnamed=',
	'\tfor repo in "$dir"/repos/*; do',
	'\t\tIFS= read -r top < "$repo" || continue',
	'\t\tcase $input in *"$top"*) named=1; break ;; esac',
	'\tdone',
	'\tn=0',
	'\tfor repo in "$dir"/repos/*; do',
	'\t\tIFS= read -r top < "$repo" || continue',
	'\t\t[ -d "$top" ] || continue',
	'\t\tcase $input in *"$top"*) ;; *) [ -z "$named" ] || continue; case $top/ in "$cwd"/*) ;; *) continue ;; esac ;; esac',
	'\t\tn=$((n + 1))',
	`\t\t[ "$n" -le ${MAX_REPOSITORIES} ] || break`,
	'\t\tgit_in "$top" ls-files -s > "$snap/$n.before" 2>/dev/null || { rm -f "$snap/$n.before"; continue; }',
	`\t\t{ printf '%s\\n' "$top"; git_in "$top" rev-parse -q --verify HEAD 2>/dev/null; } > "$snap/$n.repo"`,
	'\tdone',
	'\t[ "$n" -gt 0 ] || rm -rf "$snap"',
	'\texit 0',
	'fi',
	'',
	'if [ "$kind" = shell ]; then',
	'\tset -- "$dir"/pending/*',
	'\tif [ -d "$1" ]; then',
	'\t\tid=$(field tool_use_id)',
	`\t\tcase $id in ''|*[!A-Za-z0-9_-]*) id=none ;; esac`,
	'\t\tsnap="$dir/pending/$id"',
	'\t\tif [ -d "$snap" ] && mkdir -p "$dir/events" 2>/dev/null; then',
	'\t\t\t# After the shell command: what is staged now, for every repository in which that is not what it was',
	'\t\t\tsession=$(field session_id)',
	'\t\t\tIFS= read -r started < "$snap/time"',
	'\t\t\tfor meta in "$snap"/*.repo; do',
	'\t\t\t\t[ -f "$meta" ] || continue',
	'\t\t\t\tbase=${meta%.repo}',
	'\t\t\t\t{ IFS= read -r top; IFS= read -r was; } < "$meta"',
	'\t\t\t\tgit_in "$top" ls-files -s > "$base.after" 2>/dev/null || continue',
	'\t\t\t\tcmp -s "$base.before" "$base.after" && continue',
	'\t\t\t\tset -- "$dir"/events/*.git',
	`\t\t\t\t[ $# -lt ${MAX_WAITING_GIT_EVENTS} ] || break`,
	'\t\t\t\tis=$(git_in "$top" rev-parse -q --verify HEAD 2>/dev/null)',
	'\t\t\t\t{',
	`\t\t\t\t\tprintf '%s\\n' 'vs-kot git 1' "top $top" "time \${started:-0} $(date +%s)" "head \${was:-none} \${is:-none}" "session $session"`,
	`\t\t\t\t\t[ "$was" = "$is" ] || [ -z "$is" ] || printf '%s\\n' "commits $(git_in "$top" log --format=%ct "$is" \${was:+--not "$was"} | tr '\\n' ' ')"`,
	`\t\t\t\t\techo '[unstaged]'`,
	'\t\t\t\t\tgit_in "$top" diff-files --name-only',
	`\t\t\t\t\techo '[staged]'`,
	`\t\t\t\t\tgit_in "$top" diff-index --cached --name-only "\${is:-${EMPTY_TREE}}"`,
	`\t\t\t\t\techo '[index]'`,
	`\t\t\t\t\tdiff "$base.before" "$base.after" | grep '^[<>]'`,
	'\t\t\t\t} > "$base.event" 2>/dev/null',
	'\t\t\t\tmv "$base.event" "$dir/events/$(date +%s)-$$-${base##*/}.git" 2>/dev/null',
	'\t\t\tdone',
	'\t\t\trm -rf "$snap"',
	'\t\tfi',
	'\tfi',
	'\t# Of the shell commands, only those that changed files are kept. Most did not, and nothing is written for them.',
	`\tcase $input in *'"bashEditDiff"'*) ;; *) kind=done ;; esac`,
	'fi',
	'',
	'[ -d "$dir/events" ] || mkdir -p "$dir/events" 2>/dev/null || kind=full',
	'{ echo "${CLAUDE_CODE_ENTRYPOINT:-unknown}" > "$dir/heard"; } 2>/dev/null',
	'[ "$kind" != done ] || exit 0',
	`# vs-kot reads what is kept here and takes it away. While no vs-kot is open, no more than ${MAX_WAITING_EVENTS} tool calls are kept.`,
	'set -- "$dir"/events/*.json',
	`[ $# -lt ${MAX_WAITING_EVENTS} ] || kind=full`,
	'tmp="$dir/events/.$$.tmp"',
	'case $kind in',
	'\tshell) { printf \'%s\' "$input" > "$tmp"; } 2>/dev/null || { rm -f "$tmp"; exit 0; } ;;',
	'\tedit) { cat > "$tmp"; } 2>/dev/null || { rm -f "$tmp"; exit 0; } ;;',
	'\t*) cat > /dev/null 2>&1; exit 0 ;;',
	'esac',
	'mv "$tmp" "$dir/events/$(date +%s)-$$.json" 2>/dev/null || rm -f "$tmp"',
	'exit 0',
	''
].join('\n');

interface IClaudeHook {
	readonly type: 'command';
	readonly command: string;
	/** After how many seconds Claude Code stops waiting for the hook. */
	readonly timeout?: number;
}

interface IClaudeHookGroup {
	/** When Claude Code runs the hooks, in its own word. */
	readonly event: string;
	readonly matcher: string;
	readonly hooks: readonly IClaudeHook[];
}

/**
 * The hooks of the connection: one after each tool that writes files, and three around shell commands: before
 * one, after one that went well, and after one that failed. A missing script makes them do nothing, so that taking
 * the folder of the record away breaks no session of Claude Code.
 *
 * The hook before a shell command is the only one that Claude Code waits for before it does something. It ends
 * well whatever the script does, and says nothing: Claude Code would take anything else as an objection to the
 * command. It is given up on after a few seconds.
 */
function getClaudeHookGroups(scriptPath: string): IClaudeHookGroup[] {
	const quotedPath = `'${scriptPath.replace(/'/g, `'\\''`)}'`;
	const after = (kind: string): IClaudeHook => ({ type: 'command', command: `f=${quotedPath}; [ ! -f "$f" ] || exec sh "$f" ${kind} ${HOOK_MARKER}` });
	const before: IClaudeHook = { type: 'command', command: `f=${quotedPath}; [ ! -f "$f" ] || sh "$f" before >/dev/null 2>&1; exit 0 ${HOOK_MARKER}`, timeout: 10 };
	return [
		{ event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [after('edit')] },
		{ event: 'PostToolUse', matcher: 'Bash', hooks: [after('shell')] },
		{ event: 'PreToolUse', matcher: 'Bash', hooks: [before] },
		{ event: 'PostToolUseFailure', matcher: 'Bash', hooks: [after('shell')] }
	];
}

/** Thrown when the settings of Claude Code are not what they are expected to be. They are left as they are then. */
export class ClaudeSettingsError extends Error { }

/** Reads `hooks` from the settings of Claude Code: per event a list of groups, each with a list of hooks. */
function readHooks(settingsText: string): JsonObject | undefined {
	if (settingsText.trim().length === 0) {
		return undefined;
	}

	const errors: ParseError[] = [];
	const settings: unknown = parse(settingsText, errors);
	const root = asObject(settings);
	if (errors.length > 0 || !root) {
		throw new ClaudeSettingsError(localize('claudeSettingsUnreadable', "The settings file of Claude Code is not valid JSON. Nothing was changed."));
	}
	if (root.hooks === undefined) {
		return undefined;
	}

	const hooks = asObject(root.hooks);
	if (!hooks || Object.values(hooks).some(groups => !Array.isArray(groups))) {
		throw new ClaudeSettingsError(localize('claudeSettingsUnknownHooks', "The hooks in the settings file of Claude Code are not in a form that is known here. Nothing was changed."));
	}
	return hooks;
}

function isOwnHook(hook: unknown): boolean {
	return asString(asObject(hook)?.command)?.endsWith(HOOK_MARKER) ?? false;
}

function getFormatting(text: string): FormattingOptions {
	const indentation = /^([ \t]+)\S/m.exec(text)?.[1];
	return {
		insertSpaces: !indentation?.startsWith('\t'),
		tabSize: indentation && !indentation.startsWith('\t') ? indentation.length : 2,
		eol: text.includes('\r\n') ? '\r\n' : '\n'
	};
}

export const enum ClaudeHooks {
	/** The settings have no hook of the connection, for the script at this path. */
	None,
	/** They have some of them: an earlier version of this editor connected, and what came since is missing. */
	Outdated,
	Current
}

/** Which hooks of the connection the settings of Claude Code have, for the script at this path. */
export function getClaudeHooks(settingsText: string, scriptPath: string): ClaudeHooks {
	let hooks: JsonObject | undefined;
	try {
		hooks = readHooks(settingsText);
	} catch {
		return ClaudeHooks.None;
	}

	const expected = getClaudeHookGroups(scriptPath);
	const found = expected.filter(group => asArray(hooks?.[group.event]).map(asObject).some(other =>
		other?.matcher === group.matcher && asArray(other.hooks).some(hook => asObject(hook)?.command === group.hooks[0].command)));
	return found.length === expected.length ? ClaudeHooks.Current : found.length > 0 ? ClaudeHooks.Outdated : ClaudeHooks.None;
}

/**
 * Takes the hooks of the connection out of the settings of Claude Code, wherever their script is. Everything else
 * in the file stays as it is written.
 * @throws ClaudeSettingsError when the file is not understood
 */
export function removeClaudeHooks(settingsText: string): string {
	let text = settingsText;
	for (; ;) {
		const hooks = readHooks(text);
		const path = hooks ? findOwnHook(hooks) : undefined;
		if (!path) {
			return text;
		}
		text = applyEdits(text, setProperty(text, path, undefined, getFormatting(text)));
	}
}

/** Where the first hook of the connection is. A list that only it is in goes with it, up to `hooks` itself. */
function findOwnHook(hooks: JsonObject): (string | number)[] | undefined {
	for (const [event, groups] of Object.entries(hooks)) {
		const eventGroups = asArray(groups);
		for (let groupIndex = 0; groupIndex < eventGroups.length; groupIndex++) {
			const groupHooks = asArray(asObject(eventGroups[groupIndex])?.hooks);
			const hookIndex = groupHooks.findIndex(isOwnHook);
			if (hookIndex === -1) {
				continue;
			}
			if (groupHooks.length > 1) {
				return ['hooks', event, groupIndex, 'hooks', hookIndex];
			}
			if (eventGroups.length > 1) {
				return ['hooks', event, groupIndex];
			}
			return Object.keys(hooks).length > 1 ? ['hooks', event] : ['hooks'];
		}
	}
	return undefined;
}

/**
 * Puts the hooks of the connection into the settings of Claude Code, after the hooks that are there. Hooks of an
 * earlier connection are replaced. Everything else in the file stays as it is written.
 * @param scriptPath where {@link CLAUDE_HOOK_SCRIPT} is stored
 * @throws ClaudeSettingsError when the file is not understood
 */
export function addClaudeHooks(settingsText: string, scriptPath: string): string {
	let text = removeClaudeHooks(settingsText);
	for (const { event, matcher, hooks } of getClaudeHookGroups(scriptPath)) {
		text = applyEdits(text, setProperty(text, ['hooks', event, -1], { matcher, hooks }, getFormatting(text)));
	}
	return text.endsWith('\n') ? text : text + '\n';
}

// --- the service

export const IClaudeRecordService = createDecorator<IClaudeRecordService>('claudeRecordService');

export const enum ClaudeConnectionState {
	/** Not looked at yet. */
	Unknown,
	/** Claude Code has no settings folder on this computer: it is not installed, or was never started. */
	NotFound,
	NotConnected,
	Connected,
	/** Connected by an earlier version of this editor: the hooks that came since are missing. */
	NeedsUpdate
}

export interface IClaudeLastHeard {
	/** When Claude Code last ran the hook, whether or not a file was changed. */
	readonly time: number;
	/** How that session of Claude Code was started, in its own word: `claude-desktop` for the desktop app. */
	readonly entrypoint: string;
}

export interface IClaudeRecordService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeConnection: Event<void>;
	readonly connectionState: ClaudeConnectionState;

	/** The settings file of Claude Code that the connection is written to. */
	readonly settingsFile: URI;
	/** Where the hook stores what Claude Code hands it, and where the entries are kept. */
	readonly recordFolder: URI;

	/** Looks at the settings of Claude Code again. */
	refreshConnection(): Promise<ClaudeConnectionState>;

	/**
	 * Adds the hooks to the settings of Claude Code.
	 * @throws ClaudeSettingsError when the settings are not understood. They are left as they are then.
	 */
	connect(): Promise<void>;
	/** Takes the hooks out of the settings of Claude Code. What is on record stays. */
	disconnect(): Promise<void>;

	/** When Claude Code last ran the hook. `undefined` when it never did. */
	getLastHeard(): Promise<IClaudeLastHeard | undefined>;

	/** Fires when there is more on record for a file, or when what is on record for it was read. */
	readonly onDidChangeRecord: Event<URI>;
	/**
	 * What is on record for a file. It is read from disk when it is first asked for: until then there is nothing,
	 * and {@link onDidChangeRecord} fires once there is.
	 */
	getEntries(uri: URI): readonly IClaudeRecordEntry[];

	// --- what Claude Code staged

	/**
	 * Names a repository whose files are reviewed here. The script looks at these, and at no other, when Claude
	 * Code runs a shell command. Nothing is noted while Claude Code is not connected.
	 */
	registerRepository(root: URI): void;

	/** Resolves once it is known which files are held under review. Until then {@link getHold} knows none. */
	readonly whenHoldsKnown: Promise<void>;
	/** Fires with a file that is held under review now, or not anymore, or against another version than before. */
	readonly onDidChangeHolds: Event<URI>;
	/** The files that stay under review although git has their changes staged: Claude Code staged them. */
	readonly holds: readonly IClaudeHold[];
	getHold(uri: URI): IClaudeHold | undefined;

	/** The reviewer agreed to more of a held file. It is under review against this version from now on. */
	setHoldReviewed(uri: URI, blob: string): Promise<void>;
	/** The reviewer is done with a held file, or staged it themselves. */
	releaseHold(uri: URI): Promise<void>;
	/** Notes what the reviewer staged in a file themselves, so that it is not taken for something Claude Code staged. */
	noteOwnStaging(uri: URI, blob: string): Promise<void>;

	/**
	 * Reads what the script stored since the last look, so that {@link getHold} knows all there is to know.
	 * @returns whether a shell command of Claude Code that can stage in the repository of this file was still running
	 */
	settle(file: URI): Promise<boolean>;
}
