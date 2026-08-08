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
echo "Remaining tracked paths containing invisible characters:"
# Matched as raw UTF-8 bytes rather than \x{...} code points, which not every
# grep build supports: U+2060-206F, U+200B-200F, U+FEFF.
git ls-files -z | tr '\0' '\n' \
  | LC_ALL=C grep -nP '\xE2\x81[\xA0-\xAF]|\xE2\x80[\x8B-\x8F]|\xEF\xBB\xBF' \
  || echo "  none"
