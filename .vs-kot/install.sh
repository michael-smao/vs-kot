#!/bin/sh
# vs-kot: install vs-kot, or bring an installed one to the newest release.
#
#   curl -fsSL https://raw.githubusercontent.com/michael-smao/vs-kot/main/.vs-kot/install.sh | sh
#
# It reads latest.json from the newest release, downloads the zip named there, checks its SHA-256 and puts the app
# into the Applications folder. A download made this way carries no download flag, so macOS opens the app without
# the detour through "Open Anyway". Once installed, the app keeps itself up to date.
#
# The app goes to /Applications. Where you may not write there, because you are not an administrator of the Mac, or
# where vs-kot already sits in the Applications folder of your home folder, it goes to that one instead. The app
# has to be able to write to its own folder to keep itself up to date.
#
#   VS_KOT_INSTALL_DIR   another folder to install into
#   VS_KOT_MANIFEST_URL  another latest.json, for trying out a build
set -e
MANIFEST_URL="${VS_KOT_MANIFEST_URL:-https://github.com/michael-smao/vs-kot/releases/latest/download/latest.json}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
	echo "vs-kot is built for Macs with Apple Silicon only."
	exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Looking up the newest release..."
curl -fsSL "$MANIFEST_URL" -o "$TMP/latest.json"
VERSION="$(plutil -extract version raw -o - "$TMP/latest.json")"
URL="$(plutil -extract assets.darwin-arm64.url raw -o - "$TMP/latest.json")"
SHA="$(plutil -extract assets.darwin-arm64.sha256 raw -o - "$TMP/latest.json")"
case "$URL" in
	https://* | http://127.0.0.1:* | http://localhost:*) ;;
	*) echo "latest.json names a download that is not served over HTTPS. Nothing was installed."; exit 1 ;;
esac

echo "Downloading vs-kot $VERSION..."
curl -fL --progress-bar "$URL" -o "$TMP/vs-kot.zip"
if [ "$(shasum -a 256 "$TMP/vs-kot.zip" | cut -d' ' -f1)" != "$SHA" ]; then
	echo "The download does not have the SHA-256 that latest.json names. Nothing was installed."
	exit 1
fi

ditto -x -k "$TMP/vs-kot.zip" "$TMP/unpacked"
NEW="$(find "$TMP/unpacked" -maxdepth 1 -name '*.app' | head -1)"
if [ -z "$NEW" ] || ! codesign --verify --deep --strict "$NEW"; then
	echo "The download is not a valid app. Nothing was installed."
	exit 1
fi

if [ -n "$VS_KOT_INSTALL_DIR" ]; then
	DIR="$VS_KOT_INSTALL_DIR"
elif [ -d "$HOME/Applications/$(basename "$NEW")" ] || [ ! -w /Applications ]; then
	DIR="$HOME/Applications"
else
	DIR="/Applications"
fi
APP="$DIR/$(basename "$NEW")"

# A running app would go on running from files that are no longer there.
case "$(ps -axww -o command=)" in
	*"$APP/Contents/MacOS/"*) echo "vs-kot is running. Quit it and run this again."; exit 1 ;;
esac

mkdir -p "$DIR"
rm -rf "$APP.old"
if [ -e "$APP" ]; then
	mv "$APP" "$APP.old"
fi
if ! mv "$NEW" "$APP"; then
	if [ -e "$APP.old" ]; then
		mv "$APP.old" "$APP"
	fi
	echo "Could not write to $DIR. Nothing was changed."
	exit 1
fi
rm -rf "$APP.old"

echo "vs-kot $VERSION is installed in $DIR."
open "$APP"
