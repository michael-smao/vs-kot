#!/bin/sh
# vs-kot: launch the fork from source using the pinned pnpm (the global pnpm is too old for this repo).
# Usage: .vs-kot/run.sh [folder] [other code args]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/.vs-kot/bin:$PATH"
exec "$ROOT/scripts/code.sh" "$@"
