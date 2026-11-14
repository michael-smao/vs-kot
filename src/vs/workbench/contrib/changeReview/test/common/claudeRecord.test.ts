/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { addClaudeHooks, applyClaudeStaging, CLAUDE_HOOK_SCRIPT, ClaudeHooks, ClaudeSettingsError, digestClaudeHookInput, findClaudeEntry, getClaudeHooks, getClaudeStagings, hashClaudeLine, IClaudeHold, IClaudeRecordEntry, IClaudeStaging, isCurrentClaudeHookScript, parseClaudeGitEvent, parseClaudeHold, parseClaudeRecordEntry, removeClaudeHooks } from '../../common/claudeRecord.js';

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

	// --- what Claude Code staged

	const A = 'a'.repeat(40);
	const B = 'b'.repeat(40);
	const C = 'c'.repeat(40);
	const head1 = '1'.repeat(40);
	const head2 = '2'.repeat(40);
	const started = 1_700_000_100;

	/** What the script stores for a shell command that ran from `started` for two seconds. */
	const gitEvent = (parts: { head?: [string, string]; commits?: number[]; unstaged?: string[]; staged?: string[]; index: string[] }) => [
		'vs-kot git 1',
		'top /repo',
		`time ${started} ${started + 2}`,
		`head ${parts.head?.[0] ?? head1} ${parts.head?.[1] ?? head1}`,
		'session s1',
		...(parts.commits ? [`commits ${parts.commits.join(' ')} `] : []),
		'[unstaged]', ...(parts.unstaged ?? []),
		'[staged]', ...(parts.staged ?? []),
		'[index]', ...parts.index,
		''
	].join('\n');
	const was = (object: string, path: string, mode = '100644', stage = 0) => `< ${mode} ${object} ${stage}\t${path}`;
	const is = (object: string, path: string, mode = '100644', stage = 0) => `> ${mode} ${object} ${stage}\t${path}`;
	/** Which files a shell command staged, each with the versions before and after, and `!` when it was committed. */
	const stagings = (text: string) => getClaudeStagings(parseClaudeGitEvent(text)!)
		.map(staging => `${staging.path}: ${staging.before?.[0] ?? '-'} -> ${staging.after?.[0] ?? '-'}${staging.isCommitted ? ' !' : ''}`);

	test('a file is staged by Claude when its staged version took in what was in the working tree', () => {
		assert.deepStrictEqual({
			added: stagings(gitEvent({ staged: ['src/a.ts'], index: [was(A, 'src/a.ts'), is(B, 'src/a.ts')] })),
			newFile: stagings(gitEvent({ staged: ['new.ts'], index: [is(B, 'new.ts')] })),
			removed: stagings(gitEvent({ staged: ['gone.ts'], index: [was(A, 'gone.ts')] })),
			unstaged: stagings(gitEvent({ unstaged: ['src/a.ts'], index: [was(B, 'src/a.ts'), is(A, 'src/a.ts')] })),
			onlyAPartStaged: stagings(gitEvent({ unstaged: ['src/a.ts'], staged: ['src/a.ts'], index: [was(A, 'src/a.ts'), is(B, 'src/a.ts')] })),
			onlyTheModeChanged: stagings(gitEvent({ staged: ['run.sh'], index: [was(A, 'run.sh'), is(A, 'run.sh', '100755')] })),
			notAFile: stagings(gitEvent({ staged: ['link', 'sub'], index: [was(A, 'link', '120000'), is(B, 'link', '120000'), is(C, 'sub', '160000')] })),
			inAConflict: stagings(gitEvent({ index: [was(A, 'src/a.ts'), is(A, 'src/a.ts', '100644', 1), is(B, 'src/a.ts', '100644', 2), is(C, 'src/a.ts', '100644', 3)] })),
			unusualNames: stagings(gitEvent({ index: [was(A, '"sp ace \\"q\\".ts"'), is(B, '"sp ace \\"q\\".ts"'), was(A, '"tab\\there \\303\\244.ts"'), is(B, '"tab\\there \\303\\244.ts"'), was(A, 'ümlaut 😀.ts'), is(B, 'ümlaut 😀.ts')] })),
		}, {
			added: ['/repo/src/a.ts: a -> b'],
			newFile: ['/repo/new.ts: - -> b'],
			removed: ['/repo/gone.ts: a -> -'],
			unstaged: [],
			onlyAPartStaged: [],
			onlyTheModeChanged: [],
			notAFile: [],
			inAConflict: [],
			unusualNames: ['/repo/sp ace "q".ts: a -> b', '/repo/tab\there ä.ts: a -> b', '/repo/ümlaut 😀.ts: a -> b'],
		});
	});

	test('a file is committed by Claude when the commits that are new to the history were made by the command', () => {
		const index = [was(A, 'src/a.ts'), is(B, 'src/a.ts')];
		assert.deepStrictEqual({
			committed: stagings(gitEvent({ head: [head1, head2], commits: [started + 1], index })),
			severalCommits: stagings(gitEvent({ head: [head1, head2], commits: [started + 1, started], index })),
			committedAndChangedSince: stagings(gitEvent({ head: [head1, head2], commits: [started + 1], unstaged: ['src/a.ts'], index })),
			stagedAfterTheCommit: stagings(gitEvent({ head: [head1, head2], commits: [started + 1], staged: ['src/a.ts'], index })),
			firstCommit: stagings(gitEvent({ head: ['none', head2], commits: [started], index: [is(B, 'src/a.ts')] })),
			// The same entries change when another branch is checked out, or commits are pulled: those were made before
			otherBranch: stagings(gitEvent({ head: [head1, head2], commits: [started - 1], index })),
			pulledOnTopOfOwnCommit: stagings(gitEvent({ head: [head1, head2], commits: [started + 1, started - 500], index })),
			backToAnOlderCommit: stagings(gitEvent({ head: [head2, head1], commits: [], index })),
			noCommitsListed: stagings(gitEvent({ head: [head1, head2], index })),
		}, {
			committed: ['/repo/src/a.ts: a -> b !'],
			severalCommits: ['/repo/src/a.ts: a -> b !'],
			committedAndChangedSince: ['/repo/src/a.ts: a -> b !'],
			stagedAfterTheCommit: ['/repo/src/a.ts: a -> b'],
			firstCommit: ['/repo/src/a.ts: - -> b !'],
			otherBranch: [],
			pulledOnTopOfOwnCommit: [],
			backToAnOlderCommit: [],
			noCommitsListed: [],
		});
	});

	test('what is not what the script stores is not read', () => {
		assert.deepStrictEqual({
			somethingElse: parseClaudeGitEvent('{"tool_name":"Bash"}'),
			aLaterFormat: parseClaudeGitEvent('vs-kot git 2\ntop /repo\ntime 1 2\n'),
			noRepository: parseClaudeGitEvent('vs-kot git 1\ntime 1 2\n'),
			noTime: parseClaudeGitEvent('vs-kot git 1\ntop /repo\n'),
			empty: parseClaudeGitEvent(''),
			times: [parseClaudeGitEvent(gitEvent({ index: [] }))].map(event => [event?.repository, event?.start, event?.end, event?.session, event?.headBefore, event?.headAfter]),
			noCommitYet: parseClaudeGitEvent(gitEvent({ head: ['none', 'none'], index: [] }))?.headAfter,
		}, {
			somethingElse: undefined,
			aLaterFormat: undefined,
			noRepository: undefined,
			noTime: undefined,
			empty: undefined,
			times: [['/repo', started * 1000, (started + 2) * 1000, 's1', head1, head1]],
			noCommitYet: undefined,
		});
	});

	const staging = (changes: Partial<IClaudeStaging> = {}): IClaudeStaging => ({ path: '/repo/a.ts', repository: '/repo', start: 1000, time: 2000, session: 's1', before: A, after: B, isCommitted: false, headBefore: head1, ...changes });
	const hold = (changes: Partial<IClaudeHold> = {}): IClaudeHold => ({ path: '/repo/a.ts', repository: '/repo', reviewed: A, staged: B, since: 2000, time: 2000, session: 's1', isCommitted: false, headBefore: head1, events: ['e1'], ...changes });

	test('a file that Claude staged is held under review against the version from before', () => {
		const later = staging({ start: 5000, time: 6000, before: B, after: C, isCommitted: true, headBefore: head2 });
		assert.deepStrictEqual({
			staged: applyClaudeStaging(undefined, staging(), 'e1', undefined),
			newFile: applyClaudeStaging(undefined, staging({ before: undefined }), 'e1', undefined),
			removed: applyClaudeStaging(undefined, staging({ after: undefined }), 'e1', undefined),
			// The reviewer agreed to the version from before the first time. That stays what the file is reviewed against.
			stagedAgainAndCommitted: applyClaudeStaging(hold(), later, 'e2', undefined),
			anEarlierCommandReadLater: applyClaudeStaging(hold({ staged: C, time: 6000, events: ['e2'] }), staging({ start: 1000, time: 1500 }), 'e1', undefined),
			theSameCommandAgain: applyClaudeStaging(hold(), later, 'e1', undefined),
		}, {
			staged: hold(),
			newFile: hold({ reviewed: null }),
			removed: hold({ staged: null }),
			stagedAgainAndCommitted: hold({ staged: C, time: 6000, isCommitted: true, events: ['e1', 'e2'] }),
			anEarlierCommandReadLater: hold({ staged: C, time: 6000, events: ['e2', 'e1'] }),
			theSameCommandAgain: undefined,
		});
	});

	test('what the reviewer staged while a command of Claude ran is not held', () => {
		assert.deepStrictEqual({
			// An approval is staged while Claude runs its tests: the command is seen to have changed the staged version
			stagedByTheReviewer: applyClaudeStaging(undefined, staging(), 'e1', { blob: B, time: 1500 }),
			stagedByTheReviewerBefore: applyClaudeStaging(undefined, staging(), 'e1', { blob: B, time: 500 }),
			// The reviewer approved a change, then Claude staged the rest of the file: held against what was approved
			approvedThenStagedByClaude: applyClaudeStaging(undefined, staging({ after: C }), 'e1', { blob: B, time: 1500 }),
			approvedLongBefore: applyClaudeStaging(undefined, staging({ after: C }), 'e1', { blob: B, time: 500 }),
		}, {
			stagedByTheReviewer: undefined,
			stagedByTheReviewerBefore: undefined,
			approvedThenStagedByClaude: hold({ reviewed: B, staged: C }),
			approvedLongBefore: hold({ reviewed: A, staged: C }),
		});
	});

	test('a file the reviewer is done with is held again only for what Claude stages after that', () => {
		const done = hold({ released: 3000 });
		assert.deepStrictEqual({
			aCommandFromBefore: applyClaudeStaging(done, staging({ start: 2100, time: 2500, before: B, after: C }), 'e2', undefined),
			aCommandAfter: applyClaudeStaging(done, staging({ start: 4000, time: 5000, before: B, after: C }), 'e2', undefined),
			stagedByTheReviewerAfter: applyClaudeStaging(done, staging({ start: 4000, time: 5000, before: B, after: C }), 'e2', { blob: C, time: 4500 }),
			readBack: [parseClaudeHold(JSON.stringify(done)), parseClaudeHold(JSON.stringify(hold({ reviewed: null, staged: null, headBefore: null }))), parseClaudeHold(JSON.stringify(hold({ reviewed: C, original: A }))), parseClaudeHold('{"path":"/repo/a.ts"}'), parseClaudeHold('{')],
		}, {
			aCommandFromBefore: hold({ released: 3000, events: ['e1', 'e2'] }),
			aCommandAfter: hold({ reviewed: B, staged: C, since: 5000, time: 5000, events: ['e1', 'e2'] }),
			stagedByTheReviewerAfter: hold({ released: 3000, events: ['e1', 'e2'] }),
			readBack: [done, hold({ reviewed: null, staged: null, headBefore: null }), hold({ reviewed: C, original: A }), undefined, undefined],
		});
	});

	// --- the hooks

	const script = '/Users/me/.vs-kot-shared/claude-record/hook.sh';
	const ownCommand = (kind: string) => `f='${script}'; [ ! -f "$f" ] || exec sh "$f" ${kind} # vs-kot change review`;
	const ownCommandBefore = `f='${script}'; [ ! -f "$f" ] || sh "$f" before >/dev/null 2>&1; exit 0 # vs-kot change review`;

	test('connecting adds four hooks after the ones that are there, and disconnecting gives the file back as it was', () => {
		// the way Claude Code writes its settings
		const settings = JSON.stringify({
			permissions: { allow: ['Bash(ls:*)'] },
			hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] }
		}, undefined, 2) + '\n';

		const connected = addClaudeHooks(settings, script);
		assert.deepStrictEqual({
			parsed: JSON.parse(connected),
			isConnected: getClaudeHooks(connected, script),
			wasConnected: getClaudeHooks(settings, script),
			isConnectedForAnotherFolder: getClaudeHooks(connected, '/elsewhere/hook.sh'),
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
					],
					// The one hook that Claude Code waits for before it does something: it ends well whatever happens
					PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: ownCommandBefore, timeout: 10 }] }],
					PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'command', command: ownCommand('shell') }] }]
				}
			},
			isConnected: ClaudeHooks.Current,
			wasConnected: ClaudeHooks.None,
			isConnectedForAnotherFolder: ClaudeHooks.None,
			connectedTwice: true,
			disconnected: settings,
		});
	});

	test('a connection that an earlier version made is told from a full one, and is brought up to date by connecting again', () => {
		// what version 1 of the connection wrote: its two hooks, which are still the first two
		const earlier = JSON.stringify({
			hooks: {
				PostToolUse: [
					{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: ownCommand('edit') }] },
					{ matcher: 'Bash', hooks: [{ type: 'command', command: ownCommand('shell') }] }
				]
			}
		}, undefined, 2) + '\n';
		const updated = addClaudeHooks(earlier, script);
		assert.deepStrictEqual({
			earlier: getClaudeHooks(earlier, script),
			updated: getClaudeHooks(updated, script),
			events: Object.entries(JSON.parse(updated).hooks).map(([event, groups]) => `${event}: ${(groups as unknown[]).length}`),
			disconnected: JSON.parse(removeClaudeHooks(updated)),
		}, {
			earlier: ClaudeHooks.Outdated,
			updated: ClaudeHooks.Current,
			events: ['PostToolUse: 2', 'PreToolUse: 1', 'PostToolUseFailure: 1'],
			disconnected: {},
		});
	});

	test('connecting works for settings without hooks, and disconnecting takes away only what connecting added', () => {
		const withoutHooks = '{\n  "model": "opus"\n}\n';
		const moved = addClaudeHooks(addClaudeHooks(withoutHooks, '/old place/hook.sh'), `/it's here/hook.sh`);
		assert.deepStrictEqual({
			noFile: Object.keys(JSON.parse(addClaudeHooks('', script)).hooks),
			withoutHooks: Object.keys(JSON.parse(addClaudeHooks(withoutHooks, script))),
			disconnected: removeClaudeHooks(addClaudeHooks(withoutHooks, script)),
			neverConnected: removeClaudeHooks(withoutHooks),
			movedCommands: JSON.parse(moved).hooks.PostToolUse.map((group: { hooks: { command: string }[] }) => group.hooks[0].command),
			otherEventsStay: JSON.parse(removeClaudeHooks(addClaudeHooks('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}', script))),
		}, {
			noFile: ['PostToolUse', 'PreToolUse', 'PostToolUseFailure'],
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
			newer: isCurrentClaudeHookScript(CLAUDE_HOOK_SCRIPT.replace('hook version 2:', 'hook version 3:') + '# more'),
			changedByHand: isCurrentClaudeHookScript(CLAUDE_HOOK_SCRIPT + 'echo more\n'),
			older: isCurrentClaudeHookScript(CLAUDE_HOOK_SCRIPT.replace('hook version 2:', 'hook version 1:')),
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
			isConnected: getClaudeHooks('{ "hooks": ', script),
		}, { notJson: true, notAnObject: true, hooksAsList: true, eventAsObject: true, isConnected: ClaudeHooks.None });
	});
});
