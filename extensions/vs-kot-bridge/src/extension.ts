/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the bridge. Programs on this computer, such as Anydeck, see through it how the review stands, and tell
// vs-kot what to do: approve, step through changes, accept a suggestion, also while another app is in front.
// The socket is in ./server.ts, what its requests do is in src/vs/workbench/contrib/vsKotBridge.

import * as vscode from 'vscode';
import { installAnydeckExtension, offerAnydeckExtension } from './anydeck';
import { BridgeServer } from './server';

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel(vscode.l10n.t('Bridge'), { log: true });
	const server = new BridgeServer(log);
	const isEnabled = () => vscode.workspace.getConfiguration('bridge').get<boolean>('enabled', true);

	context.subscriptions.push(
		log,
		server,
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('bridge.enabled')) {
				if (isEnabled()) {
					server.start();
				} else {
					server.stop();
				}
			}
		}),
		vscode.commands.registerCommand('bridge.installAnydeckExtension', () => installAnydeckExtension(context)),
	);

	if (isEnabled()) {
		server.start();
	}
	offerAnydeckExtension(context);
}
