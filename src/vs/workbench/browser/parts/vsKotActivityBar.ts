/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the activity bar shows Search, Explorer and Tab Completion only. The other built-in views lose their icon but not
// their place in the product: they still open from the View menu, the command palette and their shortcuts, and
// a right click on the bar brings an icon back.

/**
 * Raise this when the lists below change. Profiles that already got an older version get the new one once.
 */
export const vsKotActivityBarDefaultsVersion = 1;

/** The views that keep their icon, in the order they are shown. */
const shownByDefault: readonly string[] = ['workbench.view.search', 'workbench.view.explorer', 'workbench.view.tabCompletion'];

/** The views that lose their icon. */
const hiddenByDefault: readonly string[] = ['workbench.view.scm', 'workbench.view.debug', 'workbench.view.extensions'];

interface IActivityBarEntry {
	readonly id: string;
	readonly pinned: boolean;
	readonly visible: boolean;
	readonly order?: number;
}

/**
 * Turns what a profile remembers about its activity bar icons into the fork's default: the views in
 * `shownByDefault` come first and are pinned, the ones in `hiddenByDefault` are unpinned, and every other
 * entry, such as an icon added by an extension, stays as it is.
 *
 * Entries that are new get a rising `order`: the bar sorts a view it has not seen before in front of the
 * first entry that has none, which would put it above Search.
 */
export function applyVsKotActivityBarDefaults(stored: readonly IActivityBarEntry[]): IActivityBarEntry[] {
	const result: IActivityBarEntry[] = [];

	for (const [index, id] of shownByDefault.entries()) {
		const entry = stored.find(candidate => candidate.id === id);
		result.push({ ...(entry ?? { id, visible: false, order: index }), pinned: true });
	}

	for (const entry of stored) {
		if (!shownByDefault.includes(entry.id)) {
			result.push(hiddenByDefault.includes(entry.id) ? { ...entry, pinned: false } : entry);
		}
	}

	for (const [index, id] of hiddenByDefault.entries()) {
		if (!stored.some(entry => entry.id === id)) {
			result.push({ id, pinned: false, visible: false, order: shownByDefault.length + index });
		}
	}

	return result;
}
