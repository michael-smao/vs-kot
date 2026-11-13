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
const provider = load('provider.js', ['toItem', 'cleanUp', 'fitToContext', 'estimateTokens', 'countCoveredClosers', 'isWellFormed']).__test;
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

// --- files that are never sent
const secret = ['/p/.env', '/p/.env.local', '/p/.env-production', '/p/prod.env', '/p/.envrc', '/p/terraform.tfvars', '/p/.pgpass', '/p/.git-credentials', '/p/.pypirc', '/p/secrets/db.ts', '/p/.ssh/config', '/p/.aws/credentials', '/p/id_rsa', '/p/server.key', '/p/cert.pem', '/p/.npmrc', '/p/credentials.json', '/p/secret.yaml'];
const fine = ['/p/src/environment.ts', '/p/src/env.ts', '/p/src/keyboard.ts', '/p/src/secretary.ts', '/p/README.md', '/p/src/credentialsForm.tsx', '/p/src/keys/index.ts'];
check('files that usually hold secrets are recognised', secret.every(f => context.NEVER_SHARE.test(f)), 'not recognised: ' + (secret.filter(f => !context.NEVER_SHARE.test(f)).join(', ') || 'none'));
check('ordinary source files are not taken for secrets', fine.every(f => !context.NEVER_SHARE.test(f)), 'wrongly held back: ' + (fine.filter(f => context.NEVER_SHARE.test(f)).join(', ') || 'none'));
console.log(failed === 0 ? 'all passed' : `${failed} failed`); process.exit(failed === 0 ? 0 : 1);
