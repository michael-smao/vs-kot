/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the whole file. Every release carries a small file, `latest.json`, that says which version it is and where
// its download is. This file holds the rules for reading it and for deciding whether it is an update for the running
// app. It is kept free of Node and Electron so that the rules can be tested on their own.

import { URI } from '../../../base/common/uri.js';
import { IUpdate } from './update.js';

/** One downloadable build inside a release manifest. */
export interface IVsKotReleaseAsset {
	readonly url?: string;
	readonly sha256?: string;
	/** The signature of this download made with the release key, see `vsKotReleaseStatement`. */
	readonly signature?: string;
}

/** The content of `latest.json`. Everything is optional here because the file comes from the network. */
export interface IVsKotReleaseManifest {
	readonly version?: string;
	readonly commit?: string;
	readonly date?: string;
	readonly assets?: { readonly [platform: string]: IVsKotReleaseAsset | undefined };
}

/**
 * Reads a release number such as `0.5.0`. Anything else, including pre-release suffixes, is not a release number.
 */
export function parseVsKotVersion(value: string | undefined): readonly [number, number, number] | undefined {
	const match = /^(?<major>\d{1,6})\.(?<minor>\d{1,6})\.(?<patch>\d{1,6})$/.exec(value ?? '');
	if (!match?.groups) {
		return undefined;
	}
	return [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch)];
}

/**
 * Whether `candidate` is a later release than `current`. An unreadable number on either side is never newer, so a
 * broken manifest cannot trigger an install.
 */
export function isNewerVsKotVersion(candidate: string | undefined, current: string | undefined): boolean {
	const a = parseVsKotVersion(candidate);
	const b = parseVsKotVersion(current);
	if (!a || !b) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return a[i] > b[i];
		}
	}
	return false;
}

/**
 * Updates are only fetched over HTTPS. Plain HTTP is accepted for this computer itself, which is what a test of the
 * updater uses.
 */
export function isTrustedUpdateUrl(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	let uri: URI;
	try {
		uri = URI.parse(value, true);
	} catch {
		return false;
	}
	if (!uri.authority) {
		return false;
	}
	return uri.scheme === 'https' || (uri.scheme === 'http' && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(uri.authority));
}

/**
 * The text that is signed for one download of a release. It names the release number, the platform and the SHA-256
 * of the zip, so that a signature cannot be moved to another release or to another file.
 * `.vs-kot/sign-release.sh` signs the same text.
 */
export function vsKotReleaseStatement(version: string, platform: string, sha256: string): string {
	return `vs-kot release\n${version}\n${platform}\n${sha256.toLowerCase()}\n`;
}

/**
 * Turns a release manifest into an update for the running app, or `undefined` when the manifest offers nothing newer
 * for this platform or is not well formed.
 */
export function toVsKotUpdate(manifest: IVsKotReleaseManifest | null | undefined, currentVersion: string | undefined, platform: string): IUpdate | undefined {
	if (!manifest || typeof manifest.version !== 'string' || !isNewerVsKotVersion(manifest.version, currentVersion)) {
		return undefined;
	}
	const asset = manifest.assets?.[platform];
	if (!asset || typeof asset.url !== 'string' || typeof asset.sha256 !== 'string') {
		return undefined;
	}
	if (!isTrustedUpdateUrl(asset.url) || !/^[0-9a-f]{64}$/i.test(asset.sha256)) {
		return undefined;
	}
	const timestamp = typeof manifest.date === 'string' ? Date.parse(manifest.date) : NaN;
	return {
		version: typeof manifest.commit === 'string' && manifest.commit ? manifest.commit : manifest.version,
		productVersion: manifest.version,
		timestamp: Number.isNaN(timestamp) ? undefined : timestamp,
		url: asset.url,
		sha256hash: asset.sha256.toLowerCase(),
	};
}
