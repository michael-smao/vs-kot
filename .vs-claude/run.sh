#!/bin/sh
# vs-claude: launch the fork from source using the pinned pnpm (the global pnpm is too old for this repo).
# Usage: .vs-claude/run.sh [folder] [other code args]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/.vs-claude/bin:$PATH"
exec "$ROOT/scripts/code.sh" "$@"
