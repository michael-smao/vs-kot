#!/bin/sh
# vs-kot: publish what .vs-kot/package.sh built as a GitHub release.
# Usage: .vs-kot/release.sh <file with the release notes>
#
# An installed vs-kot finds a release through latest.json. So the zip and that file always go up together, under the
# tag v<release number>, and only after this script has checked that they belong together. A release without
# latest.json is invisible to installed apps; one whose latest.json names another zip is refused by them.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(dirname "$ROOT")/VSCode-darwin-arm64"
ZIP="$OUT/vs-kot-darwin-arm64.zip"
MANIFEST="$OUT/latest.json"
NOTES="$1"

if [ ! -f "$NOTES" ]; then
	echo "usage: .vs-kot/release.sh <file with the release notes>"
	exit 2
fi
if [ ! -f "$ZIP" ] || [ ! -f "$MANIFEST" ]; then
	echo "Nothing to release: run .vs-kot/package.sh first."
	exit 1
fi

VERSION="$(plutil -extract version raw -o - "$MANIFEST")"
COMMIT="$(plutil -extract commit raw -o - "$MANIFEST")"
URL="$(plutil -extract assets.darwin-arm64.url raw -o - "$MANIFEST")"
WANTED="$(plutil -extract assets.darwin-arm64.sha256 raw -o - "$MANIFEST")"
REPO="$(echo "$URL" | sed -E 's#^https://github.com/([^/]+/[^/]+)/releases/.*$#\1#')"

if [ "$(shasum -a 256 "$ZIP" | cut -d' ' -f1)" != "$WANTED" ]; then
	echo "The zip is not the one latest.json describes. Run .vs-kot/package.sh again."
	exit 1
fi

# The tag has to point at the commit the app was built from, and GitHub has to have that commit.
git -C "$ROOT" fetch --quiet origin main
if ! git -C "$ROOT" merge-base --is-ancestor "$COMMIT" origin/main; then
	echo "The app was built from $COMMIT, which is not on origin/main. Push first, or build again from main."
	exit 1
fi

gh release create "v$VERSION" --repo "$REPO" --target "$COMMIT" --title "vs-kot $VERSION" --notes-file "$NOTES" "$ZIP" "$MANIFEST"
echo "Released vs-kot $VERSION. Installed apps pick it up within the hour. Raise vsKotVersion in product.json for the next one."
