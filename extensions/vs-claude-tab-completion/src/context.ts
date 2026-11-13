/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-claude: what a completion gets to see besides the file it is in.
//
// A model that only sees the current file has to guess the names of things that live elsewhere. So two kinds of
// other code are put in front of it: the definitions the current file imports, and the parts of recently used files
// that look most like the code around the cursor. Both are found with cheap text matching, and imports that are
// not plain relative paths with the help of the language service. An index or embeddings would be more thorough, but
// a suggestion has to be there while the user is still typing.

import * as vscode from 'vscode';

/** A piece of another file, as it is shown to the model. */
export interface IContextSnippet {
	/** Path relative to the workspace. */
	readonly path: string;
	readonly text: string;
}

/** Everything from other files together stays below this, so that the prompt stays quick to process. */
const TOTAL_BUDGET_CHARS = 4000;
const IMPORTED_FILE_BUDGET_CHARS = 1400;
const OPEN_FILE_WINDOW_LINES = 40;
const MAX_OPEN_FILES = 6;
const MAX_FILE_CHARS = 400_000;
/** How many imported files are kept in memory, to not read them from disk for every suggestion. */
const MAX_REMEMBERED_FILES = 40;
/** How much the code around the cursor and a part of another file must have in common for it to be worth showing. */
const MIN_SIMILARITY = 0.08;
/**
 * While the cursor stays near a place, the same snippets are sent again. The model server keeps what it has read
 * only as long as the next request starts the same way, and the snippets are the start of every request.
 */
const REUSE_MS = 20000;
const REUSE_LINES = 15;
/** How long a suggestion waits for the language service to say where an import leads. Later answers serve the next one. */
const LANGUAGE_SERVICE_WAIT_MS = 120;
const MAX_LANGUAGE_SERVICE_LOOKUPS = 12;
const LOOKUP_VALID_MS = 5 * 60 * 1000;

/** Files that are never shown to a model, wherever it runs. */
const NEVER_SHARE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|credentials(\..*)?|secrets?(\..*)?)$/i;

const JS_FAMILY = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
const JS_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
const IGNORED_WORDS = new Set(['const', 'function', 'return', 'import', 'export', 'from', 'class', 'interface', 'type', 'async', 'await', 'public', 'private', 'readonly', 'static', 'string', 'number', 'boolean', 'void', 'null', 'undefined', 'true', 'false', 'this', 'self', 'def', 'for', 'while', 'else', 'elif', 'new', 'let', 'var', 'not', 'and', 'with', 'None', 'True', 'False', 'print']);

interface ICached {
	readonly uri: string;
	readonly line: number;
	readonly time: number;
	readonly snippets: IContextSnippet[];
}

/** Where an import that is not a relative path leads. Without `uri` it leads to a package, or nowhere. */
interface ILookup {
	readonly time: number;
	readonly uri: vscode.Uri | undefined;
}

/** Whether a file is one that usually holds secrets. Such files are never shown to a model, wherever it runs. */
export function isNeverShared(uri: vscode.Uri): boolean {
	return NEVER_SHARE.test(uri.path);
}

/** The name the model is given for the project: the name of the workspace folder the file is in. */
export function getRepositoryName(uri: vscode.Uri): string {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (folder) {
		return folder.name;
	}
	const parts = uri.path.split('/').filter(part => part.length > 0);
	return parts.length > 1 ? parts[parts.length - 2] : 'project';
}

/** The path of a file as the model sees it: relative to the workspace, and only the name for files outside of it. */
export function getShownPath(uri: vscode.Uri): string {
	const relative = vscode.workspace.asRelativePath(uri, false);
	return /^(?:[\\/]|[A-Za-z]:)/.test(relative) ? relative.split(/[\\/]/).pop() ?? relative : relative;
}

export class ContextCollector implements vscode.Disposable {

	/** Other files the user looked at, most recent first. */
	private _recent: vscode.Uri[] = [];
	private _cached: ICached | undefined;
	private readonly _fileTexts = new Map<string, { mtime: number; text: string }>();
	private readonly _lookups = new Map<string, ILookup>();
	private readonly _pendingLookups = new Map<string, Promise<vscode.Uri | undefined>>();
	private readonly _listener: vscode.Disposable;

	constructor(private readonly _log: vscode.LogOutputChannel) {
		this._listener = vscode.window.onDidChangeActiveTextEditor(editor => this._remember(editor?.document));
		for (const editor of vscode.window.visibleTextEditors) {
			this._remember(editor.document);
		}
	}

	dispose(): void {
		this._listener.dispose();
	}

	private _remember(document: vscode.TextDocument | undefined): void {
		if (!document || (document.uri.scheme !== 'file' && document.uri.scheme !== 'vscode-remote')) {
			return;
		}
		const key = document.uri.toString();
		this._recent = [document.uri, ...this._recent.filter(uri => uri.toString() !== key)].slice(0, MAX_OPEN_FILES + 1);
		this._lookUpImportsAhead(document);
	}

	/** Finds out where the imports of a file lead as soon as it is looked at, so that the first suggestion in it already knows. */
	private async _lookUpImportsAhead(document: vscode.TextDocument): Promise<void> {
		try {
			await this._getImports(document);
		} catch {
			// the suggestion that needs them tries again
		}
	}

	async collect(document: vscode.TextDocument, position: vscode.Position): Promise<IContextSnippet[]> {
		const uri = document.uri.toString();
		const cached = this._cached;
		if (cached && cached.uri === uri && Math.abs(cached.line - position.line) <= REUSE_LINES && Date.now() - cached.time < REUSE_MS) {
			return cached.snippets;
		}

		const snippets: IContextSnippet[] = [];
		let budget = TOTAL_BUDGET_CHARS;
		const used = new Set<string>([uri]);
		try {
			// What the file imports comes first: it changes the least, and it is what the code at the cursor talks about
			for (const imported of await this._getImports(document)) {
				if (budget < 200 || used.has(imported.uri.toString())) {
					continue;
				}
				used.add(imported.uri.toString());
				const text = await this._readFile(imported.uri);
				if (text === undefined) {
					continue;
				}
				const part = pickDefinitions(text, imported.names, Math.min(IMPORTED_FILE_BUDGET_CHARS, budget));
				if (part) {
					snippets.push({ path: getShownPath(imported.uri), text: part });
					budget -= part.length;
				}
			}

			// Then the parts of recently used files that look most like the code around the cursor
			const around = document.getText(new vscode.Range(Math.max(0, position.line - 20), 0, position.line + 6, 0));
			const wanted = getWords(around);
			const candidates: { similarity: number; snippet: IContextSnippet }[] = [];
			for (const other of this._recent) {
				if (used.has(other.toString()) || NEVER_SHARE.test(other.path)) {
					continue;
				}
				const otherDocument = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === other.toString());
				if (!otherDocument || !isSameFamily(document.languageId, otherDocument.languageId) || otherDocument.getText().length > MAX_FILE_CHARS) {
					continue;
				}
				const best = pickSimilarWindow(otherDocument.getText(), wanted);
				if (best && best.similarity >= MIN_SIMILARITY) {
					candidates.push({ similarity: best.similarity, snippet: { path: getShownPath(other), text: best.text } });
				}
			}
			for (const candidate of candidates.sort((a, b) => b.similarity - a.similarity)) {
				if (candidate.snippet.text.length <= budget) {
					snippets.push(candidate.snippet);
					budget -= candidate.snippet.text.length;
				}
			}
		} catch (error) {
			this._log.warn(`Could not collect code from other files: ${error instanceof Error ? error.message : String(error)}`);
		}

		this._log.trace(`other files shown to the model: ${snippets.map(snippet => `${snippet.path} (${snippet.text.length})`).join(', ') || 'none'}`);
		this._cached = { uri, line: position.line, time: Date.now(), snippets };
		return snippets;
	}

	/** The files of the project that the document imports, with the names it takes from each. */
	private async _getImports(document: vscode.TextDocument): Promise<{ uri: vscode.Uri; names: string[] }[]> {
		const head = document.getText(new vscode.Range(0, 0, Math.min(document.lineCount, 120), 0));
		const folder = vscode.Uri.joinPath(document.uri, '..');
		const found: { uri: vscode.Uri; names: string[] }[] = [];

		if (JS_FAMILY.has(document.languageId)) {
			const pattern = /import\s+(?:type\s+)?(?<what>[^'"]*?)\s*from\s*['"](?<path>[^'"\n]+)['"]|require\(\s*['"](?<required>[^'"\n]+)['"]\s*\)/g;
			// All imports are looked up at the same time, so that together they take no longer than the slowest one
			const resolving: Promise<{ uri: vscode.Uri; names: string[] } | undefined>[] = [];
			let lookups = 0;
			for (const match of head.matchAll(pattern)) {
				const specifier = match.groups?.path ?? match.groups?.required;
				if (!specifier) {
					continue;
				}
				const names = getWordList(match.groups?.what ?? '');
				if (specifier.startsWith('.')) {
					resolving.push(this._resolve(folder, specifier.replace(/\.(js|mjs|cjs)$/, ''), JS_SUFFIXES).then(uri => uri && { uri, names }));
				} else if (specifier.includes('/') && lookups < MAX_LANGUAGE_SERVICE_LOOKUPS) {
					// An alias such as "@/lib/money", or a file of a package. Only the language service knows which.
					lookups++;
					const inSpecifier = document.positionAt(match.index + match[0].lastIndexOf(specifier) + 1);
					resolving.push(this._resolveWithLanguageService(document, folder, specifier, inSpecifier).then(uri => uri && { uri, names }));
				}
			}
			for (const resolved of await Promise.all(resolving)) {
				if (resolved) {
					found.push(resolved);
				}
			}
		} else if (document.languageId === 'python') {
			const pattern = /^\s*from\s+(?<module>\.*[\w.]*)\s+import\s+(?<what>[^\n#]+)|^\s*import\s+(?<plain>[\w.]+)/gm;
			const roots = [folder, ...(vscode.workspace.getWorkspaceFolder(document.uri) ? [vscode.workspace.getWorkspaceFolder(document.uri)!.uri] : [])];
			for (const match of head.matchAll(pattern)) {
				const module = (match.groups?.module ?? match.groups?.plain ?? '').replace(/^\.+/, '');
				if (!module) {
					continue;
				}
				for (const root of roots) {
					const uri = await this._resolve(root, module.replace(/\./g, '/'), ['.py', '/__init__.py']);
					if (uri) {
						found.push({ uri, names: getWordList(match.groups?.what ?? '') });
						break;
					}
				}
			}
		}
		return found;
	}

	private async _resolve(folder: vscode.Uri, specifier: string, suffixes: string[]): Promise<vscode.Uri | undefined> {
		for (const suffix of suffixes) {
			const candidate = vscode.Uri.joinPath(folder, specifier + suffix);
			if (NEVER_SHARE.test(candidate.path)) {
				continue;
			}
			try {
				const stat = await vscode.workspace.fs.stat(candidate);
				if (stat.type === vscode.FileType.File && stat.size <= MAX_FILE_CHARS) {
					return candidate;
				}
			} catch {
				// no such file
			}
		}
		return undefined;
	}

	/**
	 * Asks the language service where an import leads, the way "Go to Definition" on its path does. A suggestion
	 * does not wait long for that: an answer that comes later is kept, and the snippets are collected anew.
	 * @param inSpecifier a position inside the path of the import
	 */
	private async _resolveWithLanguageService(document: vscode.TextDocument, folder: vscode.Uri, specifier: string, inSpecifier: vscode.Position): Promise<vscode.Uri | undefined> {
		const key = `${folder.toString()}\n${specifier}`;
		const known = this._lookups.get(key);
		if (known && Date.now() - known.time < LOOKUP_VALID_MS) {
			return known.uri;
		}

		let pending = this._pendingLookups.get(key);
		if (!pending) {
			pending = this._lookUp(document, inSpecifier).then(uri => {
				this._pendingLookups.delete(key);
				this._lookups.set(key, { time: Date.now(), uri });
				return uri;
			});
			this._pendingLookups.set(key, pending);
		}

		let isLate = false;
		const late = new Promise<undefined>(resolve => setTimeout(() => {
			isLate = true;
			resolve(undefined);
		}, LANGUAGE_SERVICE_WAIT_MS));
		pending.then(uri => {
			if (isLate && uri) {
				this._cached = undefined; // the next suggestion gets to see this file
			}
		});
		return Promise.race([pending, late]);
	}

	private async _lookUp(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Uri | undefined> {
		try {
			const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>('vscode.executeDefinitionProvider', document.uri, position);
			for (const location of locations ?? []) {
				const uri = location instanceof vscode.Location ? location.uri : location.targetUri;
				// Code of the project only: what packages offer, the model knows or cannot be shown in full anyway
				if (uri.toString() === document.uri.toString() || uri.path.includes('/node_modules/') || NEVER_SHARE.test(uri.path) || !vscode.workspace.getWorkspaceFolder(uri)) {
					continue;
				}
				const stat = await vscode.workspace.fs.stat(uri);
				if (stat.type === vscode.FileType.File && stat.size <= MAX_FILE_CHARS) {
					return uri;
				}
			}
		} catch {
			// no language service for this file, or it is not ready yet
		}
		return undefined;
	}

	/** The text of a file: what an open editor shows if there is one, and otherwise what is on disk. */
	private async _readFile(uri: vscode.Uri): Promise<string | undefined> {
		const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
		if (open) {
			return open.getText();
		}
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			const known = this._fileTexts.get(uri.toString());
			if (known && known.mtime === stat.mtime) {
				return known.text;
			}
			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
			if (this._fileTexts.size >= MAX_REMEMBERED_FILES) {
				this._fileTexts.clear();
			}
			this._fileTexts.set(uri.toString(), { mtime: stat.mtime, text });
			return text;
		} catch {
			return undefined;
		}
	}
}

function isSameFamily(a: string, b: string): boolean {
	return a === b || (JS_FAMILY.has(a) && JS_FAMILY.has(b));
}

function getWordList(text: string): string[] {
	return [...text.matchAll(/[A-Za-z_$][\w$]*/g)].map(match => match[0]).filter(word => word !== 'as' && word !== 'type');
}

function getWords(text: string): Set<string> {
	const words = new Set<string>();
	for (const match of text.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
		if (!IGNORED_WORDS.has(match[0])) {
			words.add(match[0]);
		}
	}
	return words;
}

/**
 * The part of an imported file that matters: all of it when it is small, and otherwise the places where the
 * imported names are defined.
 */
function pickDefinitions(text: string, names: string[], budget: number): string {
	const trimmed = text.replace(/\s+$/, '');
	if (trimmed.length <= budget) {
		return trimmed;
	}

	const lines = trimmed.split('\n');
	const picked: string[] = [];
	let size = 0;
	const taken = new Set<number>();
	for (const name of names) {
		const definition = new RegExp(`\\b(?:export|function|class|interface|type|enum|const|let|var|def)\\b[^\\n]*\\b${escapeRegExp(name)}\\b`);
		const start = lines.findIndex((line, index) => !taken.has(index) && definition.test(line));
		if (start === -1) {
			continue;
		}
		// A definition goes on until the next line that starts a new one at the same depth, but not forever
		let end = start + 1;
		while (end < lines.length && end - start < 30 && !(lines[end].trim() !== '' && !/^[\s})\]]/.test(lines[end]))) {
			end++;
		}
		const block = lines.slice(start, end).join('\n').replace(/\s+$/, '');
		if (size + block.length > budget) {
			continue;
		}
		for (let index = start; index < end; index++) {
			taken.add(index);
		}
		picked.push(block);
		size += block.length + 1;
	}
	return picked.length > 0 ? picked.join('\n\n') : trimmed.slice(0, budget).replace(/\n[^\n]*$/, '');
}

/** The stretch of a file that shares the most words with the code around the cursor. */
function pickSimilarWindow(text: string, wanted: Set<string>): { similarity: number; text: string } | undefined {
	if (wanted.size === 0) {
		return undefined;
	}
	const lines = text.split('\n');
	let best: { similarity: number; start: number } | undefined;
	for (let start = 0; start < Math.max(1, lines.length - OPEN_FILE_WINDOW_LINES / 2); start += OPEN_FILE_WINDOW_LINES / 2) {
		const words = getWords(lines.slice(start, start + OPEN_FILE_WINDOW_LINES).join('\n'));
		if (words.size === 0) {
			continue;
		}
		let shared = 0;
		for (const word of words) {
			if (wanted.has(word)) {
				shared++;
			}
		}
		const similarity = shared / (words.size + wanted.size - shared);
		if (!best || similarity > best.similarity) {
			best = { similarity, start };
		}
	}
	return best && { similarity: best.similarity, text: lines.slice(best.start, best.start + OPEN_FILE_WINDOW_LINES).join('\n').replace(/\s+$/, '') };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
