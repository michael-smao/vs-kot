/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the extension for Anydeck that comes with the app. Its source is in .vs-kot/anydeck; .vs-kot/package.sh packs
// it into anydeck/ next to this extension. Opening the file hands it to Anydeck, which shows what it is and installs it.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const OFFERED_KEY = 'bridge.anydeckExtensionOffered';
const ANYDECK_APPS = ['/Applications/Anydeck.app', path.join(os.homedir(), 'Applications', 'Anydeck.app')];

/** The packed extension in this build, the newest one where there are several. */
async function findPackedExtension(context: vscode.ExtensionContext): Promise<string | undefined> {
	const folder = context.asAbsolutePath('anydeck');
	try {
		const files = (await fs.readdir(folder)).filter(name => name.endsWith('.anydeck-actionsource'));
		files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		return files.length ? path.join(folder, files[files.length - 1]) : undefined;
	} catch {
		return undefined;
	}
}

async function isAnydeckInstalled(): Promise<boolean> {
	if (process.platform !== 'darwin') {
		return false;
	}
	const found = await Promise.all(ANYDECK_APPS.map(app => fs.stat(app).then(() => true, () => false)));
	return found.includes(true);
}

export async function installAnydeckExtension(context: vscode.ExtensionContext): Promise<void> {
	const file = await findPackedExtension(context);
	if (!file) {
		vscode.window.showInformationMessage(vscode.l10n.t('This build of vs-kot has no extension for Anydeck.'));
		return;
	}
	await context.globalState.update(OFFERED_KEY, path.basename(file));
	if (!await vscode.env.openExternal(vscode.Uri.file(file))) {
		vscode.window.showErrorMessage(vscode.l10n.t('Anydeck did not take the extension. Drop {0} under Settings → Extensions in Anydeck.', file));
	}
}

/** Asks once on a Mac with Anydeck, and once more for every new version of the extension. */
export async function offerAnydeckExtension(context: vscode.ExtensionContext): Promise<void> {
	const file = await findPackedExtension(context);
	if (!file || !await isAnydeckInstalled()) {
		return;
	}
	const offered = context.globalState.get<string>(OFFERED_KEY);
	if (offered === path.basename(file)) {
		return;
	}
	await context.globalState.update(OFFERED_KEY, path.basename(file));

	const message = offered
		? vscode.l10n.t('This release of vs-kot brings a new version of its extension for Anydeck.')
		: vscode.l10n.t('Anydeck is on this Mac. Its vs-kot extension puts the review and tab completion on the keys and the display.');
	const install = vscode.l10n.t('Install');
	if (await vscode.window.showInformationMessage(message, install, vscode.l10n.t('Not Now')) === install) {
		await installAnydeckExtension(context);
	}
}
