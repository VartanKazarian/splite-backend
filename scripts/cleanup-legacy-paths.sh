#!/usr/bin/env bash
# Removes the broken paths currently tracked in splite-backend.
#
# Three of them contain U+2060 (WORD JOINER), an invisible character that makes
# `require('../config')` fail at runtime while the file looks correct on GitHub.
#
# Run from the repository root, on a branch, before applying the Phase 1 files.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

remove() {
  if git ls-files --error-unmatch "$1" >/dev/null 2>&1; then
    git rm -r --quiet -- "$1"
    printf 'removed: %q\n' "$1"
  else
    printf 'not tracked, skipping: %q\n' "$1"
  fi
}

# Directory literally named $'⁠src' — the real src/config.js was never
# importable from src/connectors/base.js.
remove $'⁠src'

# src/middleware/schemas.js with a trailing word joiner.
remove $'src/middleware/schemas.js⁠'

# Misspelled ignore file: .env was never actually ignored.
remove '.gitiignore'

echo
# Checked in Node rather than with `grep -P`: BSD grep (macOS) has no -P, so the
# previous pipeline exited 2 with "invalid option -- P" and the caller read that
# as "no invisible characters found".
node "$(dirname "${BASH_SOURCE[0]}")/check-invisible-paths.js"
