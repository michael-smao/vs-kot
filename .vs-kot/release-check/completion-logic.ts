/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: checks the parts of the tab completion extension that need no editor: what Tab would leave on the line, how
// prompts are cut to the context, which files are never sent. Loads the compiled files with a stand-in for "vscode".
//
//   node .vs-kot/release-check/completion-logic.ts

import * as fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { repo } from './isolated.ts';

const require = createRequire(import.meta.url);
const out = path.join(repo, 'extensions', 'vs-kot-tab-completion', 'out');
class Position { constructor(line, character) { this.line = line; this.character = character; } translate(l, c) { return new Position(this.line + l, this.character + c); } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class InlineCompletionItem { constructor(insertText, range) { this.insertText = insertText; this.range = range; } }
const vscode = { Position, Range, InlineCompletionItem, EventEmitter: class { constructor() { this.event = () => ({ dispose() { } }); } fire() { } dispose() { } }, workspace: { getWorkspaceFolder: () => undefined, asRelativePath: u => u.path }, window: { onDidChangeActiveTextEditor: () => ({ dispose() { } }), visibleTextEditors: [] }, Uri: {}, l10n: { t: s => s } };
function load(file, expose) {
	const code = fs.readFileSync(path.join(out, file), 'utf8') + `\nmodule.exports.__test = { ${expose.join(', ')} };`;
	const module = { exports: {} };
	const requireFn = name => name === 'vscode' ? vscode : name.startsWith('.') ? load(name.replace(/^\.\//, '') + '.js', []) : require(name);
	vm.runInThisContext(Module.wrap(code), { filename: file })(module.exports, requireFn, module, file, out);
	return module.exports;
}
const provider = load('provider.js', ['toItem', 'cleanUp', 'fitToContext', 'estimateTokens', 'countCoveredClosers', 'isWellFormed', 'getReadEnd']).__test;
const context = load('context.js', ['NEVER_SHARE']).__test;
let failed = 0; const check = (name, ok, detail) => { if (!ok) { failed++; } console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// --- what Tab leaves on the line: text before the cursor | closing characters right of it, and the suggestion
const lineAfterTab = (before, closers, suggestion) => {
	const item = provider.toItem({ lineAt: () => ({ text: before + closers }) }, new Position(0, before.length), new Position(0, before.length), suggestion, closers);
	return before + suggestion + closers.slice(item.range.end.character - before.length);
};
for (const [before, closers, suggestion, expected] of [
	['    name: ', ',', 'getName(a, b)', '    name: getName(a, b),'],
	['    return `Hello ${customer.', '}`', 'displayName}, welcome to our shop!`;', '    return `Hello ${customer.displayName}, welcome to our shop!`;'],
	['    return `Hello ${customer.', '}`', 'displayName', '    return `Hello ${customer.displayName}`'],
	['fn(', ')', 'a) + (b', 'fn(a) + (b)'],
	['const x = \'', '\'', 'foo\'', 'const x = \'foo\''],
	['const x = ', ';', 'foo();', 'const x = foo();'],
	['const x = ', ';', 'foo(); bar()', 'const x = foo(); bar();'],
	['foo(', ')', 'a, b)', 'foo(a, b)'],
	['foo(', ')', 'a, b', 'foo(a, b)'],
	['items.map(', ')', '(item) => item.name', 'items.map((item) => item.name)'],
	['items.map(', ')', '(item) => item.name);', 'items.map((item) => item.name);'],
	['const list = [', '];', '1, 2, 3', 'const list = [1, 2, 3];'],
	['const list = [', '];', '1, 2, 3];', 'const list = [1, 2, 3];'],
	['if (a', ') {', ' && b', 'if (a && b) {'],
	['<div className="', '">', 'box', '<div className="box">'],
	['<div className="', '">', 'box">', '<div className="box">'],
	['print(f"{name', '}")', '!r', 'print(f"{name!r}")'],
]) {
	const got = lineAfterTab(before, closers, suggestion);
	check(`Tab on  ${before}▸${closers}  with  ${suggestion}`, got === expected, got === expected ? got : `got ${got}   expected ${expected}`);
}

// --- an answer that only repeats what follows offers nothing
check('an answer that repeats the next lines is dropped', provider.cleanUp({ text: '}\n\nfunction next() {', isCutOff: false }, '\n}\n\nfunction next() {\n    return 1;\n}', false) === '', JSON.stringify(provider.cleanUp({ text: '}\n\nfunction next() {', isCutOff: false }, '\n}\n\nfunction next() {\n    return 1;\n}', false)));

// --- the estimate must not be below what the model server counted (measured on this Mac with the real tokenizer)
const rnd = (() => { let s = 7; return n => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; }; })();
const measured = { digits: [' '.repeat(0) + Array.from({ length: 900 }, () => String(100000000 + rnd(899999999))).join(' '), 1 / 1.08], hex: [Array.from({ length: 9000 }, () => '0123456789abcdef'[rnd(16)]).join(''), 1 / 1.08] };
for (const [name, [text, tokensPerChar]] of Object.entries(measured)) {
	const estimate = provider.estimateTokens(text); const real = Math.round(text.length * tokensPerChar);
	check(`estimate for ${name} is not below the measured count`, estimate >= real * 0.98, `${estimate} estimated, about ${real} measured for ${text.length} characters`);
}
const ts = fs.readFileSync(path.join(repo, 'src/vs/editor/contrib/suggest/browser/suggestModel.ts'), 'utf8').slice(0, 9706);
check('ordinary code is estimated well below the context, so nothing of it is cut', provider.estimateTokens(ts) < 7800 && provider.estimateTokens(ts) >= 2055, `${provider.estimateTokens(ts)} estimated, 2055 measured for ${ts.length} characters`);

// --- cutting to the context
const numbers = measured.digits[0];
const fitted = provider.fitToContext([{ path: 'a.ts', text: numbers.slice(0, 4000) }, { path: 'b.ts', text: ts.slice(0, 1500) }], numbers.slice(0, 4800), numbers.slice(0, 800), 8192 - 128 - 256, 1);
check('a prompt full of numbers is cut to what fits', fitted.estimate <= 7808 && fitted.prefix.length >= 600 && fitted.snippets.length < 2, `${fitted.snippets.length} other file(s), ${fitted.prefix.length} characters before and ${fitted.suffix.length} after the cursor, estimated ${fitted.estimate} tokens`);
const normal = provider.fitToContext([{ path: 'a.ts', text: ts.slice(0, 2000) }, { path: 'b.ts', text: ts.slice(2000, 4000) }], ts.slice(0, 4800), ts.slice(4800, 5600), 7808, 1);
check('a prompt of ordinary code is left as it is', normal.snippets.length === 2 && normal.prefix.length === 4800 && normal.suffix.length === 800, `estimated ${normal.estimate} tokens`);

// --- reading ahead: the pieces in which code is handed to the model server before a suggestion is asked for
const piecesOf = (text, known) => { const ends = []; for (let at = known; at < text.length && ends.length < 100;) { at = provider.getReadEnd(text, at); ends.push(at); } return ends; };
const pieces = piecesOf(ts.slice(0, 7000), 2000);
const sizes = pieces.map((end, index) => end - (index === 0 ? 2000 : pieces[index - 1]));
check('code is read ahead in pieces that end with a line and with the text', pieces.at(-1) === 7000 && pieces.slice(0, -1).every(end => ts[end - 1] === '\n') && sizes.every(size => size >= 500 && size <= 2500) && pieces.length >= 3, `pieces of ${sizes.join(', ')} characters`);
check('a little unread code is one piece', piecesOf(ts.slice(0, 3200), 2000).join() === '3200', '');
const oneLine = piecesOf('x'.repeat(9000), 0);
check('a line without end is read ahead in pieces too', oneLine.at(-1) === 9000 && oneLine.length >= 6, `${oneLine.length} pieces`);

// --- files that are never sent
const secret = ['/p/.env', '/p/.env.local', '/p/.env-production', '/p/prod.env', '/p/.envrc', '/p/terraform.tfvars', '/p/.pgpass', '/p/.git-credentials', '/p/.pypirc', '/p/secrets/db.ts', '/p/.ssh/config', '/p/.aws/credentials', '/p/id_rsa', '/p/server.key', '/p/cert.pem', '/p/.npmrc', '/p/credentials.json', '/p/secret.yaml'];
const fine = ['/p/src/environment.ts', '/p/src/env.ts', '/p/src/keyboard.ts', '/p/src/secretary.ts', '/p/README.md', '/p/src/credentialsForm.tsx', '/p/src/keys/index.ts'];
check('files that usually hold secrets are recognised', secret.every(f => context.NEVER_SHARE.test(f)), 'not recognised: ' + (secret.filter(f => !context.NEVER_SHARE.test(f)).join(', ') || 'none'));
check('ordinary source files are not taken for secrets', fine.every(f => !context.NEVER_SHARE.test(f)), 'wrongly held back: ' + (fine.filter(f => context.NEVER_SHARE.test(f)).join(', ') || 'none'));

// --- statistics: which of the items the editor is handed is a new suggestion, and what an accepted one wrote
const usage = load('usage.js', ['readRecord', 'addToRecord', 'summarize', 'toDay']);
const counted = () => { const sum = { shown: 0, accepted: 0, lines: 0, characters: 0 }; return { sum, counter: new usage.SuggestionCounter(counts => { for (const name of Object.keys(counts)) { sum[name] += counts[name]; } }) }; };
const sameCounts = (a, b) => JSON.stringify(a) === JSON.stringify(b);
{
	// "foo(bar);" is suggested at offset 10, two characters of it are typed, then Tab takes the rest
	const file = { text: 'const x = ' }; const read = (from, to) => file.text.slice(from, to);
	const { sum, counter } = counted(); const [first, typedAlong, elsewhere] = [{}, {}, {}];
	counter.offer(first, { uri: 'a', start: 10, cursor: 10, end: 10, text: 'foo(bar);' }, read); counter.show(first);
	file.text += 'fo';
	counter.offer(typedAlong, { uri: 'a', start: 12, cursor: 12, end: 12, text: 'o(bar);' }, read); counter.show(typedAlong);
	const whileTyping = { ...sum };
	counter.accept(typedAlong);
	const afterTab = { ...sum };
	// the same text at the same place of another file is another suggestion
	counter.offer(elsewhere, { uri: 'b', start: 12, cursor: 12, end: 12, text: 'o(bar);' }, read); counter.show(elsewhere);
	check('a suggestion that is typed along with is counted once, and Tab counts what it wrote', sameCounts(whileTyping, { shown: 1, accepted: 0, lines: 0, characters: 0 }) && sameCounts(afterTab, { shown: 1, accepted: 1, lines: 1, characters: 7 }) && sum.shown === 2, `while typing ${JSON.stringify(whileTyping)}, after Tab ${JSON.stringify(afterTab)}, with the other file ${JSON.stringify(sum)}`);
}
{
	// typed is "na", the entry "name" of the suggestion list is selected, and the bracket right of the cursor is replaced
	const { sum, counter } = counted(); const item = {};
	counter.offer(item, { uri: 'a', start: 4, cursor: 6, end: 7, text: 'name, b)' }, () => '');
	counter.accept(item);
	check('what was typed already and what is replaced are not counted as written', sameCounts(sum, { shown: 1, accepted: 1, lines: 1, characters: 5 }), JSON.stringify(sum));
}
{
	// three lines, taken in two steps: first a word, then the rest
	const { sum, counter } = counted(); const item = {};
	counter.offer(item, { uri: 'a', start: 0, cursor: 0, end: 0, text: 'if (a) {\n    b();\n}' }, () => ''); counter.show(item);
	counter.accept(item, 2);
	const afterWord = { ...sum };
	counter.accept(item);
	check('a suggestion taken in parts is one accepted suggestion with all its lines', sameCounts(afterWord, { shown: 1, accepted: 1, lines: 1, characters: 2 }) && sameCounts(sum, { shown: 1, accepted: 1, lines: 3, characters: 19 }), `after the word ${JSON.stringify(afterWord)}, after the rest ${JSON.stringify(sum)}`);
}
{
	// an entry of the suggestion list is accepted with Enter: that part is not the suggestion's
	const { sum, counter } = counted(); const item = {};
	counter.offer(item, { uri: 'a', start: 0, cursor: 2, end: 2, text: 'name.trim()' }, () => ''); counter.show(item);
	counter.skip(item, 4);
	counter.accept(item);
	check('what an entry of the suggestion list wrote is not counted', sameCounts(sum, { shown: 1, accepted: 1, lines: 1, characters: 7 }), JSON.stringify(sum));
}

// --- statistics: the days
{
	const { readRecord, addToRecord, summarize, toDay } = usage.__test;
	const one = { shown: 4, accepted: 1, lines: 2, characters: 30 };
	const now = new Date(2026, 2, 3, 12); // 3 March, so that the week reaches back into February
	const record = readRecord({ since: '2026-01-01', total: { shown: 'many', accepted: -3 }, days: { 'not a day': one, '2026-02-25': { shown: 1.9 } } }, toDay(now));
	const read = JSON.stringify(record);
	for (const [year, month, day] of [[2026, 2, 3], [2026, 2, 3], [2026, 1, 25], [2026, 1, 24], [2025, 11, 31]]) { addToRecord(record, toDay(new Date(year, month, day)), one); }
	const summary = summarize(record, now);
	check('what was stored is read with care: only days, only counts', read === JSON.stringify({ since: '2026-01-01', total: { shown: 0, accepted: 0, lines: 0, characters: 0 }, days: { '2026-02-25': { shown: 1, accepted: 0, lines: 0, characters: 0 } } }), read);
	check('today, the last seven days and all time are summed from the days', summary.since === '2026-01-01' && summary.today.shown === 8 && summary.week.shown === 13 && summary.week.characters === 90 && summary.total.shown === 20 && summary.total.accepted === 5, JSON.stringify(summary));
	const long = readRecord(undefined, '2026-01-01');
	for (let day = 1; day <= 120; day++) { addToRecord(long, toDay(new Date(2026, 0, day)), one); }
	const days = Object.keys(long.days).sort();
	check('old days are only kept in the total', days.length === 92 && days.at(-1) === toDay(new Date(2026, 0, 120)) && long.total.shown === 480 && long.since === '2026-01-01', `${days.length} days from ${days[0]} to ${days.at(-1)}, ${long.total.shown} shown in total`);
}
console.log(failed === 0 ? 'all passed' : `${failed} failed`); process.exit(failed === 0 ? 0 : 1);
