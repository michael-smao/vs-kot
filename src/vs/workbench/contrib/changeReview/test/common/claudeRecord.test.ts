/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { addClaudeHooks, CLAUDE_HOOK_SCRIPT, ClaudeSettingsError, digestClaudeHookInput, findClaudeEntry, hasClaudeHooks, hashClaudeLine, IClaudeRecordEntry, isCurrentClaudeHookScript, parseClaudeRecordEntry, removeClaudeHooks } from '../../common/claudeRecord.js';

suite('ClaudeRecord', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const time = 1_700_000_000_000;
	const h = (...lines: string[]) => lines.map(line => hashClaudeLine(line)!);
	const digest = (toolName: string, toolInput: object, toolResponse?: object, cwd = '/repo') =>
		digestClaudeHookInput({ session_id: 's1', cwd, hook_event_name: 'PostToolUse', tool_name: toolName, tool_input: toolInput, tool_response: toolResponse }, time);
	const entry = (path: string, tool: string, changes: Partial<IClaudeRecordEntry>): IClaudeRecordEntry => ({ path, time, session: 's1', tool, added: [], removed: [], ...changes });

	test('an edit is the lines it wrote and the lines it took away, without the lines it only repeated', () => {
		assert.deepStrictEqual(
			digest('Edit', { file_path: '/repo/a.ts', old_string: 'function a() {\n\treturn 1;\n}', new_string: 'function a() {\n\treturn 2;\n\t// two\n}' }),
			[entry('/repo/a.ts', 'Edit', { added: h('return 2;', '// two'), removed: h('return 1;') })]
		);
	});

	test('a written file is all its lines when it is new, and what the tool says it changed when it was there', () => {
		assert.deepStrictEqual({
			created: digest('Write', { file_path: '/repo/new.ts', content: 'export const a = 1;\n\nexport const b = 2;\n' }, { type: 'create', filePath: '/repo/new.ts', structuredPatch: [], originalFile: null }),
			updated: digest('Write', { file_path: '/repo/old.ts', content: 'const a = 1;\nconst b = 3;\n' }, { type: 'update', structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' const a = 1;', '-const b = 2;', '+const b = 3;'] }] }),
			updatedWithoutPatch: digest('Write', { file_path: '/repo/old.ts', content: 'const a = 1;\nconst b = 3;\n' }, { originalFile: 'const a = 1;\nconst b = 2;\n' }),
		}, {
			created: [entry('/repo/new.ts', 'Write', { added: h('export const a = 1;', 'export const b = 2;') })],
			updated: [entry('/repo/old.ts', 'Write', { added: h('const b = 3;'), removed: h('const b = 2;') })],
			updatedWithoutPatch: [entry('/repo/old.ts', 'Write', { added: h('const b = 3;'), removed: h('const b = 2;') })],
		});
	});

	test('a shell command is the files it says it changed', () => {
		assert.deepStrictEqual({
			changed: digest('Bash', { command: 'sed -i s/1/2/ a.ts && rm b.ts && make' }, {
				stdout: '', bashEditDiff: {
					files: [
						{ filePath: '/repo/a.ts', hunks: [{ lines: [' x', '-const a = 1;', '+const a = 2;'] }] },
						{ filePath: '/repo/b.ts', deleted: true, hunks: [{ lines: ['-gone();'] }] },
						{ filePath: 'c.ts', created: true, hunks: [] }
					],
					moreFiles: 1,
					changedFiles: ['/repo/a.ts', '/repo/b.ts', 'c.ts', '/repo/generated.ts']
				}
			}),
			nothingChanged: digest('Bash', { command: 'ls' }, { stdout: 'a.ts' }),
			notTracked: digest('Bash', { command: 'make' }, { bashEditDiff: { files: [], moreFiles: 0, unavailable: true } }),
		}, {
			changed: [
				entry('/repo/a.ts', 'Bash', { added: h('const a = 2;'), removed: h('const a = 1;') }),
				entry('/repo/b.ts', 'Bash', { removed: h('gone();') }),
				entry('/repo/c.ts', 'Bash', { isWithoutLines: true }),
				entry('/repo/generated.ts', 'Bash', { isWithoutLines: true })
			],
			nothingChanged: [],
			notTracked: [],
		});
	});

	test('what is not a tool call that changed a file leaves no entry', () => {
		assert.deepStrictEqual({
			read: digest('Read', { file_path: '/repo/a.ts' }),
			noPath: digest('Edit', { old_string: 'a', new_string: 'b' }),
			noObject: digestClaudeHookInput('Edit', time),
			nothing: digestClaudeHookInput(undefined, time),
		}, { read: [], noPath: [], noObject: [], nothing: [] });
	});

	test('an entry is read back as it was stored', () => {
		const stored = entry('/repo/a.ts', 'Edit', { added: h('a'), removed: h('b') });
		const withoutLines = entry('/repo/a.ts', 'Bash', { isWithoutLines: true });
		assert.deepStrictEqual({
			stored: parseClaudeRecordEntry(JSON.stringify(stored)),
			withoutLines: parseClaudeRecordEntry(JSON.stringify(withoutLines)),
			cutOff: parseClaudeRecordEntry('{"path":"/repo/a.ts","time":'),
			somethingElse: parseClaudeRecordEntry('{"time":1}'),
		}, { stored, withoutLines, cutOff: undefined, somethingElse: undefined });
	});

	test('a change is Claude\'s when at least half of its lines are lines that Claude wrote into the file', () => {
		const older = entry('/repo/a.ts', 'Edit', { time: time - 1000, added: h('const total = sum(items);', 'return total * rate;', '}'), removed: h('return 0;') });
		const newer = entry('/repo/a.ts', 'Edit', { added: h('log(total);') });
		const entries = [newer, older];
		const find = (added: string[], removed: string[] = []) => findClaudeEntry(entries, added, removed)?.time;

		assert.deepStrictEqual({
			itsLines: find(['const total = sum(items);', 'return total * rate;']),
			indentedAnew: find(['\t\tconst total = sum(items);', '    return total * rate;']),
			halfRewrittenSince: find(['const total = sum(items);', 'return applyRate(total);']),
			mostlySomeoneElses: find(['const total = sum(items);', 'audit(total);', 'report(total);']),
			someoneElses: find(['const x = 1;']),
			onlyABracketInCommon: find(['if (x) {', '}']),
			theLatestEntryThatSaysSo: find(['return total * rate;', 'log(total);']),
			removedLines: find([], ['return 0;']),
			removedBySomeoneElse: find([], ['return 1;']),
			emptyLines: find(['', '  ']),
			nothingOnRecord: findClaudeEntry([], ['const total = sum(items);'], []),
		}, {
			itsLines: time - 1000,
			indentedAnew: time - 1000,
			halfRewrittenSince: time - 1000,
			mostlySomeoneElses: undefined,
			someoneElses: undefined,
			onlyABracketInCommon: undefined,
			theLatestEntryThatSaysSo: time,
			removedLines: time - 1000,
			removedBySomeoneElse: undefined,
			emptyLines: undefined,
			nothingOnRecord: undefined,
		});
	});

	test('a file that Claude changed in lines that are not on record has all its changes marked', () => {
		const entries = [entry('/repo/a.ts', 'Bash', { isWithoutLines: true }), entry('/repo/a.ts', 'Edit', { time: time + 1, added: h('known();') })];
		assert.deepStrictEqual({
			knownLine: findClaudeEntry(entries, ['known();'], [])?.tool,
			anyOtherLine: findClaudeEntry(entries, ['generated();'], [])?.tool,
		}, { knownLine: 'Edit', anyOtherLine: 'Bash' });
	});

	const script = '/Users/me/.vs-kot-shared/claude-record/hook.sh';
	const ownCommand = (kind: string) => `f='${script}'; [ ! -f "$f" ] || exec sh "$f" ${kind} # vs-kot change review`;

	test('connecting adds two hooks after the ones that are there, and disconnecting gives the file back as it was', () => {
		// the way Claude Code writes its settings
		const settings = JSON.stringify({
			permissions: { allow: ['Bash(ls:*)'] },
			hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] }
		}, undefined, 2) + '\n';

		const connected = addClaudeHooks(settings, script);
		assert.deepStrictEqual({
			parsed: JSON.parse(connected),
			isConnected: hasClaudeHooks(connected, script),
			wasConnected: hasClaudeHooks(settings, script),
			isConnectedForAnotherFolder: hasClaudeHooks(connected, '/elsewhere/hook.sh'),
			connectedTwice: addClaudeHooks(connected, script) === connected,
			disconnected: removeClaudeHooks(connected),
		}, {
			parsed: {
				permissions: { allow: ['Bash(ls:*)'] },
				hooks: {
					PostToolUse: [
						{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] },
						{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: ownCommand('edit') }] },
						{ matcher: 'Bash', hooks: [{ type: 'command', command: ownCommand('shell') }] }
					]
				}
			},
			isConnected: true,
			wasConnected: false,
			isConnectedForAnotherFolder: false,
			connectedTwice: true,
			disconnected: settings,
		});
	});

	test('connecting works for settings without hooks, and disconnecting takes away only what connecting added', () => {
		const withoutHooks = '{\n  "model": "opus"\n}\n';
		const moved = addClaudeHooks(addClaudeHooks(withoutHooks, '/old place/hook.sh'), `/it's here/hook.sh`);
		assert.deepStrictEqual({
			noFile: JSON.parse(addClaudeHooks('', script)).hooks.PostToolUse.length,
			withoutHooks: Object.keys(JSON.parse(addClaudeHooks(withoutHooks, script))),
			disconnected: removeClaudeHooks(addClaudeHooks(withoutHooks, script)),
			neverConnected: removeClaudeHooks(withoutHooks),
			movedCommands: JSON.parse(moved).hooks.PostToolUse.map((group: { hooks: { command: string }[] }) => group.hooks[0].command),
			otherEventsStay: JSON.parse(removeClaudeHooks(addClaudeHooks('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}', script))),
		}, {
			noFile: 2,
			withoutHooks: ['model', 'hooks'],
			disconnected: withoutHooks,
			neverConnected: withoutHooks,
			movedCommands: [
				`f='/it'\\''s here/hook.sh'; [ ! -f "$f" ] || exec sh "$f" edit # vs-kot change review`,
				`f='/it'\\''s here/hook.sh'; [ ! -f "$f" ] || exec sh "$f" shell # vs-kot change review`
			],
			otherEventsStay: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } },
		});
	});

	test('the stored script is replaced unless it is this one or a newer one', () => {
		assert.deepStrictEqual({
			thisOne: isCurrentClaudeHookScript(CLAUDE_HOOK_SCRIPT),
			newer: isCurrentClaudeHookScript(CLAUDE_HOOK_SCRIPT.replace('hook version 1:', 'hook version 2:') + '# more'),
			changedByHand: isCurrentClaudeHookScript(CLAUDE_HOOK_SCRIPT + 'echo more\n'),
			older: isCurrentClaudeHookScript(CLAUDE_HOOK_SCRIPT.replace('hook version 1:', 'hook version 0:')),
			somethingElse: isCurrentClaudeHookScript('#!/bin/sh\n'),
			missing: isCurrentClaudeHookScript(undefined),
		}, { thisOne: true, newer: true, changedByHand: false, older: false, somethingElse: false, missing: false });
	});

	test('settings that are not understood are left alone', () => {
		const isRefused = (settings: string) => {
			try {
				addClaudeHooks(settings, script);
				return false;
			} catch (error) {
				return error instanceof ClaudeSettingsError;
			}
		};
		assert.deepStrictEqual({
			notJson: isRefused('{ "hooks": '),
			notAnObject: isRefused('[]'),
			hooksAsList: isRefused('{ "hooks": [] }'),
			eventAsObject: isRefused('{ "hooks": { "PostToolUse": {} } }'),
			isConnected: hasClaudeHooks('{ "hooks": ', script),
		}, { notJson: true, notAnObject: true, hooksAsList: true, eventAsObject: true, isConnected: false });
	});
});
