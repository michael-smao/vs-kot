/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: turns what a code model answers into inline suggestions.
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
/** The least code before the cursor that is sent, however little of it fits. */
const MIN_PREFIX_CHARS = 600;
/**
 * What is left free in the context besides the room for the answer. The sizes above are in characters, the
 * context is in tokens, and how many tokens a text makes is only known for sure once the model server has read it.
 */
const PROMPT_MARGIN_TOKENS = 256;
/**
 * How long an answer may take. Reading a long prompt for the first time takes the 7B model several seconds on a fast
 * Mac and more on a slower one; the model server keeps what it has read, so the next request is quick.
 */
const REQUEST_TIMEOUT_MS = 30000;
/**
 * The pause in typing that is waited for after a request was overtaken by the next keystroke. Someone who types
 * with short breaks would otherwise send a request in every break, each of them read by the model for nothing.
 * Not for nothing is the first request at a place the model server has not read yet: reading takes seconds there,
 * and the sooner it starts the better. So the longer pause only applies where the server knows the code already.
 */
const PAUSE_AFTER_OVERTAKEN_MS = 300;
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
	/** Makes sure the model is in memory. Loading it is not something a request may be cancelled in the middle of. */
	prepare?(): Promise<void>;
	/** Told after every answer. */
	noteUse?(): void;
}

/** What the model answered. */
interface IAnswer {
	readonly text: string;
	/** Whether the answer ran into the length limit instead of ending by itself. */
	readonly isCutOff: boolean;
	/** How many tokens the model server made of the prompt, when it says so. */
	readonly promptTokens: number | undefined;
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
	/**
	 * Per file, how many tokens its prompts really made compared to what was estimated. Text that is unlike code,
	 * such as tables of numbers or another script, is then cut to what fits, and no shorter.
	 */
	private readonly _tokensPerEstimate = new Map<string, number>();
	private _backoffUntil = 0;
	private _isReachable = true;
	/**
	 * Resolves when the model server is done with the request that was sent to it last, whether anybody still waits
	 * for its answer or not. The server works on one request at a time, and it reads a prompt to its end even after
	 * the request was cancelled. Requests that are cancelled while they are read would pile up in front of the one
	 * that counts: with a pause of a quarter of a second between keys, a suggestion took 5.7 seconds instead of one.
	 * So there is never more than one request at the server, and the next one is the latest that came up meanwhile.
	 */
	private _serverBusy: Promise<void> = Promise.resolve();
	/** Whether the request that was sent last was overtaken by typing before its answer was there. */
	private _wasOvertaken = false;
	/** The file and the start of the code in it that the model server read last: what it knows without reading anew. */
	private _knownWindow: string | undefined;

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

		// Wait for a pause in typing. The editor cancels this request when the next key is pressed. It has waited
		// 50 ms itself before it asked.
		const pause = configuration.get('debounce', 150);
		const window = `${document.uri.toString()}@${document.offsetAt(prefixStart)}`;
		if (!await delay(this._wasOvertaken && this._knownWindow === window ? Math.max(pause, PAUSE_AFTER_OVERTAKEN_MS) : pause, token)) {
			this._log.trace('superseded while waiting for a pause in typing');
			return undefined;
		}

		// Code from other files that helps here: what this file imports, and similar parts of recently used files
		const snippets = configuration.get('useOtherFiles', true) ? await this._context.collect(document, position) : [];
		if (token.isCancellationRequested) {
			return undefined;
		}

		// After a long pause the model has to be loaded first. Typing on must not interrupt that.
		await target.prepare?.();
		if (token.isCancellationRequested) {
			return undefined;
		}

		// One request at a time. A request that comes up while the server is busy waits here, and gives up when
		// typing goes on: of all that came up meanwhile, only the latest is sent.
		const waitStarted = Date.now();
		if (!await this._whenServerIsFree(token)) {
			this._wasOvertaken = true;
			this._log.trace('superseded while the model server was busy with the request before');
			return undefined;
		}
		if (Date.now() - waitStarted > 20) {
			this._log.trace(`waited ${Date.now() - waitStarted} ms for the model server to finish the request before`);
		}

		// The prompt has to fit into the context of the model together with the answer. What does not fit is left
		// out here, the least important first: the model server would cut the prompt at its start instead.
		const key = document.uri.toString();
		const maxTokens = Math.round(configuration.get('maxTokens', 128));
		const fitted = fitToContext(snippets, prefix, suffix, CONTEXT_TOKENS - maxTokens - PROMPT_MARGIN_TOKENS, this._tokensPerEstimate.get(key) ?? 1);

		const singleLine = restOfLine.trim().length > 0;
		const started = Date.now();
		let answer: IAnswer | undefined;
		try {
			answer = await this._request(configuration, target, fitted.snippets, document.uri, fitted.prefix, fitted.suffix, singleLine, maxTokens, token, () => this._knownWindow = window);
		} catch (error) {
			if (token.isCancellationRequested) {
				this._wasOvertaken = true;
				this._log.trace(`superseded after ${Date.now() - started} ms, while the model was answering`);
				return undefined;
			}
			this._backoffUntil = Date.now() + BACKOFF_MS;
			this._log.warn(`No answer from ${target.url}: ${error instanceof Error ? error.message : String(error)}`);
			this._setReachable(false);
			return undefined;
		}
		if (token.isCancellationRequested || answer === undefined) {
			this._wasOvertaken = token.isCancellationRequested;
			this._log.trace(`superseded after ${Date.now() - started} ms, while the model was answering`);
			return undefined;
		}
		this._wasOvertaken = false;
		this._setReachable(true);
		target.noteUse?.();
		this._learnTokens(key, fitted.estimate, answer.promptTokens);

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
	 * Waits until the model server is done with the request that was sent last.
	 * @returns `false` when the request that waits was cancelled meanwhile
	 */
	private async _whenServerIsFree(token: vscode.CancellationToken): Promise<boolean> {
		for (; ;) {
			const busy = this._serverBusy;
			const isFree = await new Promise<boolean>(resolve => {
				const listener = token.onCancellationRequested(() => {
					listener.dispose();
					resolve(false);
				});
				busy.then(() => {
					listener.dispose();
					resolve(true);
				});
			});
			if (!isFree || token.isCancellationRequested) {
				return false;
			}
			if (busy === this._serverBusy) {
				return true; // nobody else took the turn in the meantime
			}
		}
	}

	/** Compares what a prompt was estimated at with what the model server made of it. */
	private _learnTokens(key: string, estimate: number, actual: number | undefined): void {
		if (actual === undefined || estimate <= 0) {
			return;
		}
		// Far fewer tokens than estimated means that the model server cut the prompt: the estimate was too low, not too high
		const ratio = actual < estimate * 0.2 ? 1.5 : actual / estimate;
		this._tokensPerEstimate.set(key, Math.max(0.3, Math.min(2, ratio)));
		if (this._tokensPerEstimate.size > 200) {
			this._tokensPerEstimate.delete(this._tokensPerEstimate.keys().next().value!);
		}
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
	private async _request(configuration: vscode.WorkspaceConfiguration, target: ICompletionTarget, snippets: IContextSnippet[], uri: vscode.Uri, prefix: string, suffix: string, singleLine: boolean, maxTokens: number, token: vscode.CancellationToken, onDidRead: () => void): Promise<IAnswer | undefined> {
		const template = configuration.get('promptTemplate', '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>');
		// The layout the models were trained on for code that spans several files:
		//   <|repo_name|>name \n <|file_sep|>path \n code \n ... <|file_sep|>path of this file \n fill-in prompt
		const separator = configuration.get('fileSeparator', '<|file_sep|>');
		const repositoryMarker = configuration.get('repositoryMarker', '<|repo_name|>');
		const otherFiles = snippets.length > 0 && separator
			? (repositoryMarker ? `${repositoryMarker}${getRepositoryName(uri)}\n` : '') + snippets.map(snippet => `${separator}${snippet.path}\n${snippet.text}\n`).join('') + `${separator}${getShownPath(uri)}\n`
			: '';
		// In one pass: the code itself may contain "{suffix}", and that is not a placeholder
		const prompt = otherFiles + template.replace(/\{(?<part>prefix|suffix)\}/g, (_match, part) => part === 'prefix' ? prefix : suffix);
		this._log.trace(`prompt of ${prompt.length} characters, starting ${JSON.stringify(prompt.slice(0, 90))}`);

		// The model is trained to write what is missing and then to end. It does end by itself, but what it takes to
		// be missing can be more than was asked for: having finished a function, the 7B model at times goes on with
		// another one that nobody started. So a suggestion ends with its line when the line goes on behind the cursor,
		// and otherwise with its block, at the first empty line.
		// A file with Windows line endings has an empty line as "\r\n\r\n".
		const ends = singleLine ? ['\n'] : ['\n\n', '\r\n\r\n'];
		const markers = configuration.get<string[]>('stop', []);
		// Servers with the OpenAI kind of interface often take four at most. The model ends by itself with the first marker anyway.
		const stop = target.api === 'openai' ? [...ends, ...markers].slice(0, 4) : [...markers, ...ends];

		// Greedy decoding, as in Qwen's examples: the same code gets the same suggestion every time. Ollama applies
		// no penalty for repetition by itself; saying so keeps it that way on a server with other defaults.
		// From Ollama the answer comes in pieces as it is written. That is not to show it earlier, but to know when
		// the model starts to write: until then it reads the prompt, and that cannot be interrupted.
		const isStreamed = target.api === 'ollama';
		const url = target.api === 'ollama' ? `${target.url}/api/generate` : `${target.url}/v1/completions`;
		const body = target.api === 'ollama'
			? { model: target.model, prompt, raw: true, stream: true, keep_alive: '30m', options: { num_ctx: CONTEXT_TOKENS, num_predict: maxTokens, temperature: 0, repeat_penalty: 1, stop } }
			: { model: target.model, prompt, max_tokens: maxTokens, temperature: 0, stop, stream: false };

		const abort = new AbortController();
		let isTimedOut = false;
		const timeout = setTimeout(() => {
			isTimedOut = true;
			abort.abort();
		}, REQUEST_TIMEOUT_MS);

		// Whoever asks next waits for this, see _serverBusy
		let release = () => { };
		this._serverBusy = new Promise<void>(resolve => release = resolve);

		// A cancelled request is taken from the server as soon as that frees the server: at once while the model
		// writes, and when it starts to write while it still reads. What it has read is kept for the next request.
		let isWriting = false;
		const cancellation = token.onCancellationRequested(() => {
			if (isWriting || !isStreamed) {
				abort.abort();
			}
		});

		try {
			const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal });
			if (!response.ok) {
				throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 200)}`);
			}

			onDidRead(); // the answer has begun, or is there: the server has read the prompt
			if (!isStreamed || !response.body) {
				const result = await response.json() as { response?: string; done_reason?: string; prompt_eval_count?: number; choices?: { text?: string; finish_reason?: string }[]; usage?: { prompt_tokens?: number } };
				const text = target.api === 'ollama' ? result.response : result.choices?.[0]?.text;
				const reason = target.api === 'ollama' ? result.done_reason : result.choices?.[0]?.finish_reason;
				const promptTokens = target.api === 'ollama' ? result.prompt_eval_count : result.usage?.prompt_tokens;
				return text === undefined ? undefined : { text, isCutOff: reason === 'length', promptTokens };
			}

			// The answer has begun: the prompt is read. From here on a cancelled request can be taken away at once.
			isWriting = true;
			if (token.isCancellationRequested) {
				abort.abort();
				return undefined;
			}

			// One JSON object per line: a piece of the answer each, and at the end how it went
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let pending = '';
			let text = '';
			let reason: string | undefined;
			let promptTokens: number | undefined;
			for (; ;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				isWriting = true;
				if (token.isCancellationRequested) {
					abort.abort(); // it was cancelled while the prompt was read: nobody wants what is written now
					return undefined;
				}
				pending += decoder.decode(value, { stream: true });
				const lines = pending.split('\n');
				pending = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					const piece = JSON.parse(line) as { response?: string; done?: boolean; done_reason?: string; prompt_eval_count?: number; error?: string };
					if (piece.error) {
						throw new Error(piece.error);
					}
					text += piece.response ?? '';
					if (piece.done) {
						reason = piece.done_reason;
						promptTokens = piece.prompt_eval_count;
					}
				}
			}
			return { text, isCutOff: reason === 'length', promptTokens };
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
			release();
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
	if (start.character === 0 || start.line >= end.line) {
		return start;
	}
	// To the start of the next line, unless this line is so long that hardly anything would be left: a minified file
	const nextLine = new vscode.Position(start.line + 1, 0);
	return document.offsetAt(nextLine) - document.offsetAt(start) <= PREFIX_STEP_CHARS ? nextLine : start;
}

/**
 * A cautious count of the tokens the model makes of a text. Code makes about one token per four characters, but
 * digits make one each, and so can symbols and the characters of other scripts. For ordinary code the result is
 * about twice the real number, which the room in the context allows for. It must not be too low.
 */
export function estimateTokens(text: string): number {
	let tokens = 0;
	let letters = 0;
	let wasSpace = false;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95) {
			letters++;
			wasSpace = false;
			continue;
		}
		if (letters > 0) {
			tokens += Math.ceil(letters / 2);
			letters = 0;
		}
		if (code === 32 || code === 9 || code === 10 || code === 13) {
			if (!wasSpace) {
				tokens += 0.5; // one run of spaces and line breaks is mostly part of the token next to it
			}
			wasSpace = true;
			continue;
		}
		wasSpace = false;
		tokens += code >= 48 && code <= 57 ? 1.15 : code < 128 ? 1 : 1.5;
	}
	return Math.ceil(tokens + Math.ceil(letters / 2));
}

/**
 * Leaves out what does not fit into the context: first the code from other files, the last one first, then the
 * oldest lines before the cursor, in the same steps in which that start moves anyway, then half of the code after it.
 * @param tokensPerEstimate what is known about how the estimate compares to the real count for this file
 */
function fitToContext(snippets: IContextSnippet[], prefix: string, suffix: string, budget: number, tokensPerEstimate: number): { snippets: IContextSnippet[]; prefix: string; suffix: string; estimate: number } {
	const estimate = (parts: IContextSnippet[], before: string, after: string) =>
		estimateTokens(before) + estimateTokens(after) + parts.reduce((sum, part) => sum + estimateTokens(part.path) + estimateTokens(part.text) + 4, 0) + 16;
	const fits = (parts: IContextSnippet[], before: string, after: string) => estimate(parts, before, after) * tokensPerEstimate <= budget;

	let parts = snippets;
	while (parts.length > 0 && !fits(parts, prefix, suffix)) {
		parts = parts.slice(0, -1);
	}
	while (prefix.length > MIN_PREFIX_CHARS && !fits(parts, prefix, suffix)) {
		const cut = Math.min(PREFIX_STEP_CHARS, prefix.length - MIN_PREFIX_CHARS);
		const lineBreak = prefix.indexOf('\n', cut);
		prefix = prefix.slice(lineBreak !== -1 && lineBreak - cut < PREFIX_STEP_CHARS ? lineBreak + 1 : cut);
	}
	if (!fits(parts, prefix, suffix)) {
		suffix = suffix.slice(0, Math.floor(suffix.length / 2));
	}
	if (!fits(parts, prefix, suffix)) {
		// Still too much: text that makes several tokens per character. Take as much before the cursor as surely fits.
		prefix = prefix.slice(-Math.max(200, Math.floor(budget / 4)));
		suffix = suffix.slice(0, 100);
	}
	return { snippets: parts, prefix, suffix, estimate: estimate(parts, prefix, suffix) };
}

/**
 * The suggestion as the editor shows it. Closing punctuation right of the cursor, such as a bracket the editor
 * closed by itself, is replaced when the suggestion brings it along: it would be there twice otherwise.
 *
 * A model answers in one of two ways. Either with just what is missing, and then what stands right of the cursor
 * stays. Or with the whole rest of the line, and then that is replaced. Which one it is shows in the line that
 * results: only one of the two has its brackets and quotes in order.
 * @param start where the suggestion starts: at the cursor, or where the selected entry of the suggestion list starts
 * @param restOfLine what stands right of the cursor on its line
 */
function toItem(document: vscode.TextDocument, start: vscode.Position, position: vscode.Position, text: string, restOfLine: string): vscode.InlineCompletionItem {
	const closers = restOfLine.trimEnd();
	let end = position;
	if (closers && !text.includes('\n')) {
		const covered = countCoveredClosers(text, closers);
		if (covered > 0) {
			const lineBefore = document.lineAt(start.line).text.slice(0, start.character);
			const isFineWhenKept = isWellFormed(lineBefore + text + closers);
			const isFineWhenReplaced = isWellFormed(lineBefore + text + closers.slice(covered));
			// When the line cannot tell, the closing characters are only taken as the suggestion's own where it ends with them
			if (isFineWhenReplaced !== isFineWhenKept ? isFineWhenReplaced : text.endsWith(closers.slice(0, covered))) {
				end = position.translate(0, covered);
			}
		}
	}
	return new vscode.InlineCompletionItem(text, new vscode.Range(start, end));
}

/**
 * How many of the closing characters right of the cursor the suggestion contains, in their order. A character
 * inside brackets that the suggestion opened itself is not one of them: the comma in `getName(a, b)` is not the
 * comma that ends the entry.
 */
function countCoveredClosers(text: string, closers: string): number {
	let covered = 0;
	let depth = 0;
	for (const character of text) {
		if (covered === closers.length) {
			break;
		}
		if (character === '(' || character === '[' || character === '{') {
			depth++;
		} else if (character === ')' || character === ']' || character === '}') {
			depth--;
			if (depth < 0) {
				// It closes a bracket from before the cursor. What follows is on the level of the cursor again.
				depth = 0;
				if (character === closers[covered]) {
					covered++;
				}
			}
		} else if (depth === 0 && character === closers[covered]) {
			covered++;
		}
	}
	return covered;
}

/** Whether every bracket in the text is closed, none is closed that was not opened, and no quote is left open. */
function isWellFormed(text: string): boolean {
	const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
	const open: string[] = [];
	const quotes: Record<string, number> = { '\'': 0, '"': 0, '`': 0 };
	for (const character of text) {
		if (character === '(' || character === '[' || character === '{') {
			open.push(character);
		} else if (closing[character] !== undefined) {
			if (open.pop() !== closing[character]) {
				return false;
			}
		} else if (quotes[character] !== undefined) {
			quotes[character]++;
		}
	}
	return open.length === 0 && quotes['\''] % 2 === 0 && quotes['"'] % 2 === 0 && quotes['`'] % 2 === 0;
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
	// All of it can be a repetition too: then there is nothing to offer
	for (let count = Math.min(written.length, nextLines.length); count > 0; count--) {
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
