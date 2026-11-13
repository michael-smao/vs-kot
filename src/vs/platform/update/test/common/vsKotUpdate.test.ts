/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isNewerVsKotVersion, isTrustedUpdateUrl, IVsKotReleaseManifest, toVsKotUpdate } from '../../common/vsKotUpdate.js';

suite('VsKotUpdate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const sha256 = 'A'.repeat(64);
	const url = 'https://example.com/releases/download/v0.5.1/app.zip';

	test('compares release numbers by their parts, and never accepts an unreadable one', () => {
		assert.deepStrictEqual({
			patch: isNewerVsKotVersion('0.5.1', '0.5.0'),
			minorBeatsPatch: isNewerVsKotVersion('0.10.0', '0.9.9'),
			same: isNewerVsKotVersion('0.5.0', '0.5.0'),
			older: isNewerVsKotVersion('0.4.9', '0.5.0'),
			suffix: isNewerVsKotVersion('0.5.1-beta', '0.5.0'),
			prefixed: isNewerVsKotVersion('v0.5.1', '0.5.0'),
			unknownCurrent: isNewerVsKotVersion('0.5.1', undefined),
		}, {
			patch: true,
			minorBeatsPatch: true,
			same: false,
			older: false,
			suffix: false,
			prefixed: false,
			unknownCurrent: false,
		});
	});

	test('fetches updates over HTTPS only, except from this computer', () => {
		assert.deepStrictEqual({
			https: isTrustedUpdateUrl('https://example.com/latest.json'),
			http: isTrustedUpdateUrl('http://example.com/latest.json'),
			loopback: isTrustedUpdateUrl('http://127.0.0.1:8123/latest.json'),
			localhost: isTrustedUpdateUrl('http://localhost/latest.json'),
			lookalike: isTrustedUpdateUrl('http://localhost.example.com/latest.json'),
			file: isTrustedUpdateUrl('file:///tmp/latest.json'),
			noScheme: isTrustedUpdateUrl('example.com/latest.json'),
			missing: isTrustedUpdateUrl(undefined),
		}, {
			https: true,
			http: false,
			loopback: true,
			localhost: true,
			lookalike: false,
			file: false,
			noScheme: false,
			missing: false,
		});
	});

	test('reads a release manifest into an update for this platform, or into nothing', () => {
		const manifest: IVsKotReleaseManifest = { version: '0.5.1', commit: 'abc1234', date: '2026-01-02T03:04:05Z', assets: { 'darwin-arm64': { url, sha256 } } };

		assert.deepStrictEqual({
			newer: toVsKotUpdate(manifest, '0.5.0', 'darwin-arm64'),
			withoutCommitOrDate: toVsKotUpdate({ version: '0.5.1', assets: manifest.assets }, '0.5.0', 'darwin-arm64'),
			sameVersion: toVsKotUpdate(manifest, '0.5.1', 'darwin-arm64'),
			otherPlatform: toVsKotUpdate(manifest, '0.5.0', 'darwin-x64'),
			plainHttp: toVsKotUpdate({ ...manifest, assets: { 'darwin-arm64': { url: 'http://example.com/app.zip', sha256 } } }, '0.5.0', 'darwin-arm64'),
			shortHash: toVsKotUpdate({ ...manifest, assets: { 'darwin-arm64': { url, sha256: 'abc' } } }, '0.5.0', 'darwin-arm64'),
			noAssets: toVsKotUpdate({ version: '0.5.1' }, '0.5.0', 'darwin-arm64'),
			empty: toVsKotUpdate(null, '0.5.0', 'darwin-arm64'),
		}, {
			newer: { version: 'abc1234', productVersion: '0.5.1', timestamp: Date.UTC(2026, 0, 2, 3, 4, 5), url, sha256hash: sha256.toLowerCase() },
			withoutCommitOrDate: { version: '0.5.1', productVersion: '0.5.1', timestamp: undefined, url, sha256hash: sha256.toLowerCase() },
			sameVersion: undefined,
			otherPlatform: undefined,
			plainHttp: undefined,
			shortHash: undefined,
			noAssets: undefined,
			empty: undefined,
		});
	});
});
