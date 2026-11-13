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
			return [toEntry(path, getReplacement(oldLines, newLines))];
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

// --- the hook

/** Ends the commands that the connection adds to the settings of Claude Code. The shell reads it as a comment. */
const HOOK_MARKER = '# vs-kot change review';
const HOOK_EVENT = 'PostToolUse';

/** Raised with every change to {@link CLAUDE_HOOK_SCRIPT}. */
const HOOK_VERSION = 1;
/**
 * How many tool calls the script keeps for an editor to read. An editor that is open takes them away as they come.
 * The limit is for a computer on which Claude Code is connected and this editor is not used anymore: what the
 * script keeps holds whole files, and must not pile up there without end.
 */
const MAX_WAITING_EVENTS = 2000;

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
 * The script that Claude Code runs after a tool call. It is handed what the tool did on its standard input and
 * keeps that in the folder it is in, for the editor to read. It never fails, and it does not keep a tool call
 * waiting for longer than it takes to write a file.
 */
export const CLAUDE_HOOK_SCRIPT = [
	'#!/bin/sh',
	`# vs-kot change review, hook version ${HOOK_VERSION}: notes which files Claude Code changed.`,
	'#',
	'# Claude Code runs this after each of its edits and shell commands (see "hooks" in its settings.json) and hands',
	'# over what the tool did. That is kept next to this script for vs-kot to read, and it stays on this computer.',
	'# vs-kot writes this file anew when it starts: a change made here does not last.',
	'umask 077',
	'dir=${0%/*}',
	'kind=$1',
	'if [ "$kind" = shell ]; then',
	'\t# Of the shell commands, only those that changed files are kept. Most did not, and nothing is written for them.',
	'\tinput=$(cat)',
	'\tcase $input in *\'"bashEditDiff"\'*) ;; *) kind=done ;; esac',
	'fi',
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

interface IClaudeHookGroup {
	readonly matcher: string;
	readonly hooks: readonly { readonly type: 'command'; readonly command: string }[];
}

/**
 * The two hooks of the connection: one for the tools that write files, one for shell commands. A missing script
 * makes them do nothing, so that taking the folder of the record away breaks no session of Claude Code.
 */
function getClaudeHookGroups(scriptPath: string): IClaudeHookGroup[] {
	const quotedPath = `'${scriptPath.replace(/'/g, `'\\''`)}'`;
	const toGroup = (matcher: string, kind: string): IClaudeHookGroup => ({
		matcher,
		hooks: [{ type: 'command', command: `f=${quotedPath}; [ ! -f "$f" ] || exec sh "$f" ${kind} ${HOOK_MARKER}` }]
	});
	return [toGroup('Edit|Write|MultiEdit|NotebookEdit', 'edit'), toGroup('Bash', 'shell')];
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

/** Whether the settings of Claude Code have the hooks of the connection, for the script at this path. */
export function hasClaudeHooks(settingsText: string, scriptPath: string): boolean {
	let hooks: JsonObject | undefined;
	try {
		hooks = readHooks(settingsText);
	} catch {
		return false;
	}

	const groups = asArray(hooks?.[HOOK_EVENT]).map(asObject);
	return getClaudeHookGroups(scriptPath).every(expected => groups.some(group =>
		group?.matcher === expected.matcher && asArray(group.hooks).some(hook => asObject(hook)?.command === expected.hooks[0].command)));
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
	for (const group of getClaudeHookGroups(scriptPath)) {
		text = applyEdits(text, setProperty(text, ['hooks', HOOK_EVENT, -1], group, getFormatting(text)));
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
	Connected
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
}
