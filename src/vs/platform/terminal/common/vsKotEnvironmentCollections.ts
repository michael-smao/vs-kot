/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the terminal environments that VS Kot itself contributes, next to the ones of extensions. Upstream keys
// every collection by the extension that made it and drops a collection whose extension is not installed. VS Kot's
// collections belong to no extension and have to stay.

import { localize } from '../../../nls.js';

/** The collection that activates the Python environment of the open folder in new terminals. */
export const VS_KOT_PYTHON_ENVIRONMENT_COLLECTION = 'vs-kot.pythonEnvironment';

/** Whether a collection belongs to VS Kot itself rather than to an extension. */
export function isVsKotEnvironmentCollection(identifier: string): boolean {
	return identifier === VS_KOT_PYTHON_ENVIRONMENT_COLLECTION;
}

/** The name shown for a collection of VS Kot itself where an extension's name would be, or undefined for an extension's collection. */
export function getVsKotEnvironmentCollectionName(identifier: string): string | undefined {
	return identifier === VS_KOT_PYTHON_ENVIRONMENT_COLLECTION ? localize('pythonEnvironmentCollection', "Python Environment") : undefined;
}
