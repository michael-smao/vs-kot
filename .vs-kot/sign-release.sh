#!/bin/sh
# vs-kot: sign the release that .vs-kot/package.sh built. The signature goes into latest.json.
#
#   .vs-kot/sign-release.sh             sign the build in ../VSCode-darwin-arm64
#   .vs-kot/sign-release.sh --new-key   create a release key on this Mac and print its public half
#
# An installed vs-kot only installs a release that is signed with a release key. The private half of the key is a
# file on the Mac of whoever publishes releases, by default ~/.vs-kot-release/signing-key.pem. It is not in this
# repository and must never be: whoever has it can publish updates that every installed vs-kot accepts, and whoever
# has only write access to the repository cannot. The public halves of the keys the app accepts are in product.json
# (vsKotUpdatePublicKeys).
#
# Keep a copy of the key file in a safe place. If it is lost, no further release can be signed and installed apps
# accept nothing else; everyone would have to install a build with a new key by hand. To change the key without
# that, first publish a release, signed with the old key, whose product.json lists the new public key as well.
#
#   VS_KOT_SIGNING_KEY   another file that holds the private key
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(dirname "$ROOT")/VSCode-darwin-arm64"
ZIP="$OUT/vs-kot-darwin-arm64.zip"
MANIFEST="$OUT/latest.json"
PRODUCT="$OUT/vs-kot.app/Contents/Resources/app/product.json"
KEY="${VS_KOT_SIGNING_KEY:-$HOME/.vs-kot-release/signing-key.pem}"

if [ "$1" = "--new-key" ]; then
	if [ -e "$KEY" ]; then
		echo "There is a key at $KEY already. It is left as it is."
	else
		mkdir -p "$(dirname "$KEY")"
		chmod 700 "$(dirname "$KEY")"
		# The private half goes straight into the file and is not shown anywhere.
		node -e '
const fs = require("fs"), crypto = require("crypto");
const { privateKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(process.argv[1], privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
' "$KEY"
		echo "Created the release key at $KEY. Keep a copy of this file in a safe place, and nowhere else."
	fi
	echo "Its public half, for vsKotUpdatePublicKeys in product.json:"
	node -e '
const fs = require("fs"), crypto = require("crypto");
console.log(crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(process.argv[1]))).export({ format: "der", type: "spki" }).toString("base64"));
' "$KEY"
	exit 0
fi

if [ ! -f "$ZIP" ] || [ ! -f "$MANIFEST" ]; then
	echo "Nothing to sign: run .vs-kot/package.sh first."
	exit 1
fi
if [ ! -f "$KEY" ]; then
	echo "The release key is not on this Mac ($KEY). The release has to be signed where the key is."
	exit 1
fi

SHA="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
node -e '
const fs = require("fs"), crypto = require("crypto");
const [manifestPath, productPath, keyPath, sha256] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const asset = manifest.assets["darwin-arm64"];
if (asset.sha256 !== sha256) {
	console.error("The zip is not the one latest.json describes. Run .vs-kot/package.sh again.");
	process.exit(1);
}
const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
// The app that was just built has to know this key, or the releases after it could not be signed with it.
const known = JSON.parse(fs.readFileSync(productPath, "utf8")).vsKotUpdatePublicKeys || [];
const publicHalf = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
if (!known.includes(publicHalf)) {
	console.error("The key on this Mac is not one of vsKotUpdatePublicKeys in the app that was built.");
	process.exit(1);
}
// The same text as vsKotReleaseStatement in src/vs/platform/update/common/vsKotUpdate.ts.
const statement = `vs-kot release\n${manifest.version}\ndarwin-arm64\n${sha256}\n`;
asset.signature = crypto.sign(null, Buffer.from(statement, "utf8"), key).toString("base64");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
console.log(`latest.json is signed for vs-kot ${manifest.version}`);
' "$MANIFEST" "$PRODUCT" "$KEY" "$SHA"
