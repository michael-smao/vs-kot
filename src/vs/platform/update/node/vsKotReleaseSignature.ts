/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// vs-kot: the whole file. A release is only installed when it is signed with the release key. The private half of
// that key is with whoever publishes releases and is not on GitHub, so that write access to the repository alone is
// not enough to put code on every installed copy. The app carries the public halves of the keys it accepts
// (`vsKotUpdatePublicKeys` in product.json). What is signed is one short text per download, see
// `vsKotReleaseStatement`; `.vs-kot/sign-release.sh` writes the signature into latest.json.

import { createPublicKey, verify } from 'crypto';

/**
 * Whether `signature` is an Ed25519 signature of `statement` made with one of the given keys.
 *
 * @param signature base64, as found in the release manifest
 * @param publicKeys public keys in SPKI DER form, base64 encoded, as found in product.json
 */
export function isSignedByVsKotKey(statement: string, signature: string | undefined, publicKeys: readonly string[]): boolean {
	// an Ed25519 signature has 64 bytes, which are 86 characters and two padding characters in base64
	if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
		return false;
	}

	const data = Buffer.from(statement, 'utf8');
	const signatureBytes = Buffer.from(signature, 'base64');
	for (const publicKey of publicKeys) {
		try {
			const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
			if (key.asymmetricKeyType === 'ed25519' && verify(null, data, key, signatureBytes)) {
				return true;
			}
		} catch {
			// not a key: the next one may be
		}
	}
	return false;
}
