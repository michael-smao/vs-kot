#!/bin/sh
# vs-kot: build the double-clickable macOS app (Apple Silicon) and a zip to hand to teammates.
# Usage: .vs-kot/package.sh
# Result, next to the repo folder: VSCode-darwin-arm64/vs-kot.app and VSCode-darwin-arm64/vs-kot-darwin-arm64.zip
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/.vs-kot/bin:$PATH"
OUT="$(dirname "$ROOT")/VSCode-darwin-arm64"
APP="$OUT/vs-kot.app"
ZIP="$OUT/vs-kot-darwin-arm64.zip"

cd "$ROOT"

# The packaging task deletes the whole output folder first. An app that is running from there would lose its files
# while it runs, so stop instead.
case "$(ps -axww -o command=)" in
	*"$OUT/"*) echo "An app is running from $OUT. Quit it first: this build deletes that folder."; exit 1 ;;
esac

# 1. The repo's own packaging task: compiles, bundles, minifies and assembles the app (about 3 minutes).
#    It deletes and recreates the VSCode-darwin-arm64 folder.
pnpm run gulp vscode-darwin-arm64-min

# 2. Source maps only help when debugging the editor itself and are a third of the app's size.
find "$APP/Contents/Resources/app" -name '*.map' -type f -delete

# 3. The app has no Apple developer signature. Give it an ad-hoc one so the bundle is at least consistent:
#    without it macOS calls a downloaded copy "damaged" instead of offering "Open Anyway".
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

# 4. ditto keeps symlinks and permissions intact, which Finder's "Compress" and plain zip do not guarantee.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

# 5. latest.json, the small file every release carries next to the zip. An installed vs-kot reads it to learn whether
#    the release is newer than itself, where the zip is and which SHA-256 it must have. Release number and commit are
#    taken from the app that was just built, so the file cannot describe anything else.
SHA="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
node -e '
const fs = require("fs");
const [productPath, sha256, out] = process.argv.slice(1);
const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(product.vsKotVersion || "") || !/\/releases\/latest\/download\/?$/.test(product.updateUrl || "")) {
	console.error("product.json needs vsKotVersion (like 0.5.0) and an updateUrl that ends in /releases/latest/download");
	process.exit(1);
}
const releases = product.updateUrl.replace(/\/latest\/download\/?$/, "");
const manifest = {
	version: product.vsKotVersion,
	commit: product.commit,
	date: product.date,
	assets: { "darwin-arm64": { url: `${releases}/download/v${product.vsKotVersion}/vs-kot-darwin-arm64.zip`, sha256 } }
};
fs.writeFileSync(out, JSON.stringify(manifest, null, "\t") + "\n");
console.log(`latest.json describes vs-kot ${manifest.version}`);
' "$APP/Contents/Resources/app/product.json" "$SHA" "$OUT/latest.json"

du -sh "$APP" "$ZIP"
echo "Check the app with .vs-kot/release-check, then publish with: .vs-kot/release.sh <file with the release notes>"
