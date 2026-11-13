/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { generateKeyPairSync, KeyPairKeyObjectResult, sign } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { vsKotReleaseStatement } from '../../common/vsKotUpdate.js';
import { isSignedByVsKotKey } from '../../node/vsKotReleaseSignature.js';

suite('VsKotReleaseSignature', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only a signature of exactly this release, made with a key the app knows', () => {
		const publicKeyOf = (pair: KeyPairKeyObjectResult) => pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
		const ours = generateKeyPairSync('ed25519');
		const theirs = generateKeyPairSync('ed25519');
		const sha256 = 'a'.repeat(64);
		const statement = vsKotReleaseStatement('0.5.1', 'darwin-arm64', sha256);
		const signature = sign(null, Buffer.from(statement, 'utf8'), ours.privateKey).toString('base64');

		assert.deepStrictEqual({
			statement,
			signed: isSignedByVsKotKey(statement, signature, [publicKeyOf(ours)]),
			secondKeyInTheList: isSignedByVsKotKey(statement, signature, [publicKeyOf(theirs), publicKeyOf(ours)]),
			otherRelease: isSignedByVsKotKey(vsKotReleaseStatement('0.5.2', 'darwin-arm64', sha256), signature, [publicKeyOf(ours)]),
			otherZip: isSignedByVsKotKey(vsKotReleaseStatement('0.5.1', 'darwin-arm64', 'b'.repeat(64)), signature, [publicKeyOf(ours)]),
			otherPlatform: isSignedByVsKotKey(vsKotReleaseStatement('0.5.1', 'darwin-x64', sha256), signature, [publicKeyOf(ours)]),
			unknownKey: isSignedByVsKotKey(statement, signature, [publicKeyOf(theirs)]),
			noKeys: isSignedByVsKotKey(statement, signature, []),
			notAKey: isSignedByVsKotKey(statement, signature, ['not a key']),
			noSignature: isSignedByVsKotKey(statement, undefined, [publicKeyOf(ours)]),
			inventedSignature: isSignedByVsKotKey(statement, 'A'.repeat(86) + '==', [publicKeyOf(ours)]),
			tooShort: isSignedByVsKotKey(statement, signature.substring(4), [publicKeyOf(ours)]),
		}, {
			statement: `vs-kot release\n0.5.1\ndarwin-arm64\n${sha256}\n`,
			signed: true,
			secondKeyInTheList: true,
			otherRelease: false,
			otherZip: false,
			otherPlatform: false,
			unknownKey: false,
			noKeys: false,
			notAKey: false,
			noSignature: false,
			inventedSignature: false,
			tooShort: false,
		});
	});
});
