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

du -sh "$APP" "$ZIP"
