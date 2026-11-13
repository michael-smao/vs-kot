/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-claude: turns what a code model answers into inline suggestions.
//
// While typing, the code before and after the cursor is sent to a model server and its answer is shown as an
// inline suggestion, which Tab accepts. Nothing here knows about Copilot or chat, which stay switched off.

import * as vscode from 'vscode';
import { ContextCollector, IContextSnippet, getRepositoryName, getShownPath, isNeverShared } from './context';
import { CONTEXT_TOKENS } from './modelServer';

/**
 * How much of the file goes to the model. The code before the cursor is read once and then remembered by the model
 * server, so it can be long. The code after the cursor is read again on every keystroke, so it is kept short.
 */
const MAX_PREFIX_CHARS = 4800;
const MAX_SUFFIX_CHARS = 800;
/** The start of the code that is sent moves in steps of this size, see `getPrefixStart`. */
const PREFIX_STEP_CHARS = 1200;
/**
 * How long an answer may take. Reading a long prompt for the first time takes the 7B model several seconds on a fast
 * Mac and more on a slower one; the model server keeps what it has read, so the next request is quick.
 */
const REQUEST_TIMEOUT_MS = 30000;
/** After a failed request the server is left alone for a while, so that typing does not hammer a server that is down. */
const BACKOFF_MS = 15000;
/** How much text around a suggestion has to be unchanged for it to still count as the same place. */
const CONTEXT_CHECK_CHARS = 300;
/** Text right of the cursor that may stay there while something is suggested: only closing punctuation. */
const ONLY_CLOSERS = /^[\s)\]}>'"`;,]*$/;

/** Where completions come from. */
export interface ICompletionTarget {
	readonly url: string;
	readonly api: 'ollama' | 'openai';
	readonly model: string;
}

/** What the model answered. */
interface IAnswer {
	readonly text: string;
	/** Whether the answer ran into the length limit instead of ending by itself. */
	readonly isCutOff: boolean;
}

/** The last suggestion and where it was made, to recognise typing along with it. */
interface ILastSuggestion {
	readonly uri: string;
	readonly offset: number;
	readonly before: string;
	readonly after: string;
	readonly completion: string;
}

export class TabCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {

	private readonly _onDidChangeReachable = new vscode.EventEmitter<boolean>();
	/** Fires when the model server stops answering, and when it answers again. */
	readonly onDidChangeReachable = this._onDidChangeReachable.event;

	private _last: ILastSuggestion | undefined;
	private _backoffUntil = 0;
	private _isReachable = true;

	constructor(
		private readonly _log: vscode.LogOutputChannel,
		private readonly _getTarget: () => ICompletionTarget | undefined,
		private readonly _context: ContextCollector,
	) { }

	dispose(): void {
		this._onDidChangeReachable.dispose();
	}

	get isReachable(): boolean {
		return this._isReachable;
	}

	/** Forgets what was learned about the server, for example after its settings changed. */
	reset(): void {
		this._backoffUntil = 0;
		this._last = undefined;
		this._setReachable(true);
	}

	async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | undefined> {
		const configuration = vscode.workspace.getConfiguration('tabCompletion');
		if (!configuration.get('enabled', true)) {
			return undefined;
		}
		if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled' && document.uri.scheme !== 'vscode-remote') {
			return undefined; // not a file someone edits: output, git versions, settings
		}
		if (configuration.get<string[]>('disabledLanguages', ['plaintext']).includes(document.languageId)) {
			return undefined;
		}
		if (isNeverShared(document.uri)) {
			return undefined; // a file that usually holds secrets is not shown to a model
		}
		const target = this._getTarget();
		if (!target) {
			return undefined; // not set up, or still starting
		}

		// With code right of the cursor a suggestion would have to be woven into it. Only closing punctuation may follow.
		const restOfLine = document.lineAt(position.line).text.slice(position.character);
		if (!ONLY_CLOSERS.test(restOfLine)) {
			return undefined;
		}

		// While the editor's own suggestion list is open, only a suggestion that starts with its selected entry is
		// shown. So the model continues from that entry instead of from what is typed so far.
		const selected = context.selectedCompletionInfo;
		const insertStart = selected ? selected.range.start : position;
		const lead = selected ? selected.text : '';
		this._log.trace(`asked at ${position.line + 1}:${position.character + 1}${selected ? `, list entry "${lead}"` : ''}`);

		const prefixStart = getPrefixStart(document, insertStart);
		const suffixEnd = document.positionAt(document.offsetAt(position) + MAX_SUFFIX_CHARS);
		const prefix = document.getText(new vscode.Range(prefixStart, insertStart)) + lead;
		const suffix = document.getText(new vscode.Range(position, suffixEnd));
		if (prefix.trim().length === 0) {
			return undefined; // nothing to go on
		}

		// Typing along with what was just suggested needs no new request
		const rest = selected ? undefined : this._continueLast(document, position);
		if (rest) {
			this._log.trace('typing along with the last suggestion');
			return [toItem(document, position, position, rest, restOfLine)];
		}

		if (Date.now() < this._backoffUntil) {
			return undefined;
		}

		// Wait for a pause in typing. The editor cancels this request when the next key is pressed.
		if (!await delay(configuration.get('debounce', 150), token)) {
			this._log.trace('superseded while waiting for a pause in typing');
			return undefined;
		}

		// Code from other files that helps here: what this file imports, and similar parts of recently used files
		const snippets = configuration.get('useOtherFiles', true) ? await this._context.collect(document, position) : [];
		if (token.isCancellationRequested) {
			return undefined;
		}

		const singleLine = restOfLine.trim().length > 0;
		const started = Date.now();
		let answer: IAnswer | undefined;
		try {
			answer = await this._request(configuration, target, snippets, document.uri, prefix, suffix, singleLine, token);
		} catch (error) {
			if (token.isCancellationRequested) {
				this._log.trace(`superseded after ${Date.now() - started} ms, while the model was answering`);
				return undefined;
			}
			this._backoffUntil = Date.now() + BACKOFF_MS;
			this._log.warn(`No answer from ${target.url}: ${error instanceof Error ? error.message : String(error)}`);
			this._setReachable(false);
			return undefined;
		}
		if (token.isCancellationRequested || answer === undefined) {
			this._log.trace(`superseded after ${Date.now() - started} ms, while the model was answering`);
			return undefined;
		}
		this._setReachable(true);

		const completion = cleanUp(answer, suffix, singleLine);
		this._log.debug(`${Date.now() - started} ms, ${completion.length} characters, ${snippets.length} other files${selected ? `, continuing the selected entry "${lead}"` : ''}`);
		this._log.trace(`model answered ${JSON.stringify(answer.text)}${answer.isCutOff ? ', cut off at the length limit' : ''}`);
		if (!completion) {
			return undefined;
		}

		if (selected) {
			this._last = undefined;
			return [toItem(document, insertStart, position, lead + completion, restOfLine)];
		}

		this._last = { uri: document.uri.toString(), offset: document.offsetAt(position), before: prefix.slice(-CONTEXT_CHECK_CHARS), after: suffix.slice(0, CONTEXT_CHECK_CHARS), completion };
		return [toItem(document, position, position, completion, restOfLine)];
	}

	/**
	 * When the user typed the first characters of the last suggestion, the rest of it still stands.
	 * @returns the rest of the last suggestion, or `undefined` when it does not apply here
	 */
	private _continueLast(document: vscode.TextDocument, position: vscode.Position): string | undefined {
		const last = this._last;
		const offset = document.offsetAt(position);
		if (!last || last.uri !== document.uri.toString() || offset < last.offset || offset - last.offset >= last.completion.length) {
			return undefined;
		}

		const start = document.positionAt(last.offset);
		const typed = document.getText(new vscode.Range(start, position));
		const before = document.getText(new vscode.Range(document.positionAt(Math.max(0, last.offset - last.before.length)), start));
		const after = document.getText(new vscode.Range(position, document.positionAt(offset + last.after.length)));
		if (!last.completion.startsWith(typed) || before !== last.before || after !== last.after) {
			return undefined;
		}
		return last.completion.slice(typed.length);
	}

	private _setReachable(isReachable: boolean): void {
		if (this._isReachable !== isReachable) {
			this._isReachable = isReachable;
			this._onDidChangeReachable.fire(isReachable);
		}
	}

	/**
	 * Asks the model the way Qwen describes for its Coder models (README of Qwen2.5-Coder and its technical report):
	 * the fill-in prompt, for code from several files the repository layout in front of it, and greedy decoding.
	 */
	private async _request(configuration: vscode.WorkspaceConfiguration, target: ICompletionTarget, snippets: IContextSnippet[], uri: vscode.Uri, prefix: string, suffix: string, singleLine: boolean, token: vscode.CancellationToken): Promise<IAnswer | undefined> {
		const template = configuration.get('promptTemplate', '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>');
		// The layout the models were trained on for code that spans several files:
		//   <|repo_name|>name \n <|file_sep|>path \n code \n ... <|file_sep|>path of this file \n fill-in prompt
		const separator = configuration.get('fileSeparator', '<|file_sep|>');
		const repositoryMarker = configuration.get('repositoryMarker', '<|repo_name|>');
		const otherFiles = snippets.length > 0 && separator
			? (repositoryMarker ? `${repositoryMarker}${getRepositoryName(uri)}\n` : '') + snippets.map(snippet => `${separator}${snippet.path}\n${snippet.text}\n`).join('') + `${separator}${getShownPath(uri)}\n`
			: '';
		const prompt = otherFiles + template.replace('{prefix}', () => prefix).replace('{suffix}', () => suffix);
		this._log.trace(`prompt of ${prompt.length} characters, starting ${JSON.stringify(prompt.slice(0, 90))}`);

		// The model is trained to write what is missing and then to end. It does end by itself, but what it takes to
		// be missing can be more than was asked for: having finished a function, the 7B model at times goes on with
		// another one that nobody started. So a suggestion ends with its line when the line goes on behind the cursor,
		// and otherwise with its block, at the first empty line.
		const stop = [...configuration.get<string[]>('stop', []), singleLine ? '\n' : '\n\n'];
		const maxTokens = configuration.get('maxTokens', 128);

		// Greedy decoding, as in Qwen's examples: the same code gets the same suggestion every time. Ollama applies
		// no penalty for repetition by itself; saying so keeps it that way on a server with other defaults.
		const url = target.api === 'ollama' ? `${target.url}/api/generate` : `${target.url}/v1/completions`;
		const body = target.api === 'ollama'
			? { model: target.model, prompt, raw: true, stream: false, keep_alive: '30m', options: { num_ctx: CONTEXT_TOKENS, num_predict: maxTokens, temperature: 0, repeat_penalty: 1, stop } }
			: { model: target.model, prompt, max_tokens: maxTokens, temperature: 0, stop, stream: false };

		const abort = new AbortController();
		let isTimedOut = false;
		const timeout = setTimeout(() => {
			isTimedOut = true;
			abort.abort();
		}, REQUEST_TIMEOUT_MS);
		const cancellation = token.onCancellationRequested(() => abort.abort());
		try {
			const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal });
			if (!response.ok) {
				throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 200)}`);
			}
			const result = await response.json() as { response?: string; done_reason?: string; choices?: { text?: string; finish_reason?: string }[] };
			const text = target.api === 'ollama' ? result.response : result.choices?.[0]?.text;
			const reason = target.api === 'ollama' ? result.done_reason : result.choices?.[0]?.finish_reason;
			return text === undefined ? undefined : { text, isCutOff: reason === 'length' };
		} catch (error) {
			if (isTimedOut) {
				// A slow answer is not a server that is down: no suggestion this time, and no waiting period
				this._log.debug(`no answer within ${REQUEST_TIMEOUT_MS / 1000} s`);
				return undefined;
			}
			throw error;
		} finally {
			clearTimeout(timeout);
			cancellation.dispose();
		}
	}
}

/**
 * Where the code that is sent to the model starts. The model server keeps what it has read for as long as the next
 * request starts with the same text. So the start must not move with every keystroke: it moves in large steps, and
 * to the start of a line.
 * @param end where the code before the cursor ends
 */
function getPrefixStart(document: vscode.TextDocument, end: vscode.Position): vscode.Position {
	const endOffset = document.offsetAt(end);
	if (endOffset <= MAX_PREFIX_CHARS) {
		return new vscode.Position(0, 0);
	}
	const start = document.positionAt(Math.ceil((endOffset - MAX_PREFIX_CHARS) / PREFIX_STEP_CHARS) * PREFIX_STEP_CHARS);
	return start.character === 0 || start.line >= end.line ? start : new vscode.Position(start.line + 1, 0);
}

/**
 * The suggestion as the editor shows it. Closing punctuation right of the cursor, such as a bracket the editor
 * closed by itself, is replaced when the suggestion brings it along: it would be there twice otherwise.
 * @param start where the suggestion starts: at the cursor, or where the selected entry of the suggestion list starts
 * @param restOfLine what stands right of the cursor on its line
 */
function toItem(document: vscode.TextDocument, start: vscode.Position, position: vscode.Position, text: string, restOfLine: string): vscode.InlineCompletionItem {
	const closers = restOfLine.trimEnd();
	const firstLine = text.split('\n')[0];
	let end = position;
	if (closers && firstLine === text) {
		// As many of the closing characters as the suggestion contains, in their order
		let covered = 0;
		let from = 0;
		for (const character of closers) {
			const index = firstLine.indexOf(character, from);
			if (index === -1) {
				break;
			}
			covered++;
			from = index + 1;
		}
		// A suggestion like `a) + (b` in front of a `)` means the bracket that is there: then nothing is replaced
		const lineBefore = document.lineAt(start.line).text.slice(0, start.character);
		if (covered > 0 && !(isBalanced(lineBefore + text + closers) && !isBalanced(lineBefore + text + closers.slice(covered)))) {
			end = position.translate(0, covered);
		}
	}
	return new vscode.InlineCompletionItem(text, new vscode.Range(start, end));
}

/** Whether every bracket in the text is closed, and none is closed that was not opened. */
function isBalanced(text: string): boolean {
	const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
	const open: string[] = [];
	for (const character of text) {
		if (character === '(' || character === '[' || character === '{') {
			open.push(character);
		} else if (closing[character] !== undefined && open.pop() !== closing[character]) {
			return false;
		}
	}
	return open.length === 0;
}

/**
 * Turns the answer of the model into what is offered.
 * @param suffix the code after the cursor
 */
function cleanUp(answer: IAnswer, suffix: string, singleLine: boolean): string {
	let completion = answer.text.replace(/<\|[a-z_]+\|>/g, '');
	if (singleLine) {
		return completion.replace(/\s+$/, '').split('\n')[0];
	}
	// An answer that ran into the length limit ends in the middle of a line: leave that line out
	if (answer.isCutOff && completion.includes('\n')) {
		completion = completion.slice(0, completion.lastIndexOf('\n'));
	}
	completion = completion.replace(/\s+$/, '');

	// A model that does not end in time goes on into what already follows. Drop the lines at the end of the answer
	// that repeat the next lines of the file. Empty lines do not count on either side.
	const nextLines = suffix.split('\n').map(line => line.trim()).filter(line => line.length > 0);
	const lines = completion.split('\n');
	const written = lines.map((line, index) => ({ text: line.trim(), index })).filter(line => line.text.length > 0);
	for (let count = Math.min(written.length - 1, nextLines.length); count > 0; count--) {
		const tail = written.slice(written.length - count);
		if (tail.every((line, position) => line.text === nextLines[position])) {
			lines.length = tail[0].index;
			break;
		}
	}
	return lines.join('\n').replace(/\s+$/, '');
}

/**
 * @returns `false` when cancelled while waiting
 */
function delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise(resolve => {
		if (token.isCancellationRequested) {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			listener.dispose();
			resolve(true);
		}, ms);
		const listener = token.onCancellationRequested(() => {
			clearTimeout(timer);
			listener.dispose();
			resolve(false);
		});
	});
}
