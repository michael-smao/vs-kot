/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: what the checks in this folder share. Above all a model server of their own: a check must never reach
// the folder or the server that the user works with. One that did moved a download folder and restarted a server
// that was in use.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The root of the repository. */
export const repo = path.resolve(import.meta.dirname, '..', '..');

/** Where the checks keep what they create: in the build folder, which git ignores. */
export const scratch = path.join(repo, '.build', 'release-check');

/** The port of the model server that the checks start for themselves. The real one is 11535. */
export const ISOLATED_PORT = 11640;

/** Where tab completion keeps the model server and the models it downloaded. */
export const realModelServerHome = path.join(os.homedir(), '.vs-kot', 'tab-completion');

/**
 * A model server of their own for the checks, in a folder that only links to the installed model server and to
 * the models, so that nothing is downloaded.
 * @returns what to add to the environment of an editor that a check starts
 */
export function getIsolatedModelServer(): Record<string, string> {
	const home = path.join(scratch, 'tab-completion');
	fs.mkdirSync(home, { recursive: true });
	for (const name of ['runtime', 'models']) {
		const link = path.join(home, name);
		fs.rmSync(link, { force: true });
		fs.symlinkSync(path.join(realModelServerHome, name), link);
	}
	fs.rmSync(path.join(home, 'stopped'), { force: true });
	return { VS_KOT_TAB_COMPLETION_HOME: home, VS_KOT_TAB_COMPLETION_PORT: String(ISOLATED_PORT) };
}
