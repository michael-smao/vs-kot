#!/bin/sh
# vs-kot: take the folders of the Mac that built the app out of the app.
#
#   .vs-kot/strip-build-paths.sh <path to vs-kot.app>
#
# .vs-kot/package.sh runs this before it signs the app. The native modules that were compiled on this Mac carry debug
# symbols, and those name every source and object file with its full path, /Users/<name>/<folders>/node_modules/...
# Nothing reads them while the app runs, but everyone who downloads a release could. They are stripped here, and
# each stripped file gets a new ad-hoc signature, because macOS does not load code whose signature no longer fits.
#
# At the end the build stops if any file of the app still names the home folder of whoever builds. That check is
# wider than the stripping on purpose: it also catches a path that some other build step writes into the app later.
set -e
APP="$1"
if [ ! -d "$APP/Contents" ]; then
	echo "Usage: $0 <path to vs-kot.app>"
	exit 1
fi

# The symbols hold the real path, so resolve a home folder that is reached through a link.
HOME_PATH="$(cd "$HOME" && pwd -P)/"

# The files of the app that contain the path. Links are not followed, so nothing is listed twice.
files_with_path() {
	LC_ALL=C /usr/bin/grep -rlF -- "$HOME_PATH" "$APP" || true
}

files_with_path | while IFS= read -r FILE; do
	case "$(file -b "$FILE")" in
		Mach-O*)
			# -S removes the debug symbols only. What the module exports stays, so it loads as before.
			strip -S "$FILE"
			if ! codesign --force --sign - "$FILE" 2>/dev/null; then
				echo "Could not sign $FILE again after stripping it."
				exit 1
			fi
			echo "Stripped the build paths from ${FILE#"$APP"/}"
			;;
	esac
done

LEFT="$(files_with_path)"
if [ -n "$LEFT" ]; then
	echo "These files of the app still name $HOME_PATH, a folder of this Mac:"
	echo "$LEFT"
	echo "Nothing was packaged. Find out which build step writes the path and take it out before a release."
	exit 1
fi
echo "No file of the app names $HOME_PATH"
