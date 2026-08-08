#!/usr/bin/env node
//
// Fails if any tracked path contains an invisible or zero-width character.
//
// This replaces a `grep -nP '\xE2\x81[\xA0-\xAF]|...'` pipeline. That check was
// unusable on BSD grep (macOS), which has no -P at all: grep exited 2 with
// "invalid option -- P", the `if` branch read a non-zero exit as "no match",
// and the guard reported clean while never having looked at anything.
//
// Matching on decoded code points removes the dependency on a particular grep
// build, and a thrown error here fails the run rather than passing it.
'use strict';

const { execFileSync } = require('node:child_process');

// U+00AD SOFT HYPHEN, U+200B-200F zero-width and bidi marks, U+2028/2029 line
// and paragraph separators, U+2060-206F word joiner and deprecated format
// characters, U+FEFF byte order mark.
const isInvisible = (cp) =>
  cp === 0x00ad ||
  (cp >= 0x200b && cp <= 0x200f) ||
  cp === 0x2028 ||
  cp === 0x2029 ||
  (cp >= 0x2060 && cp <= 0x206f) ||
  cp === 0xfeff;

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

function trackedPaths() {
  const out = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 });
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

const offenders = [];
for (const path of trackedPaths()) {
  const found = [...path]
    .map((ch) => ch.codePointAt(0))
    .filter(isInvisible);
  if (found.length > 0) {
    offenders.push({ path, found: [...new Set(found)].map(hex) });
  }
}

if (offenders.length > 0) {
  for (const { path, found } of offenders) {
    // JSON.stringify keeps the invisible characters from vanishing in output.
    console.error(`${JSON.stringify(path)} contains ${found.join(', ')}`);
  }
  console.error(`\n${offenders.length} tracked path(s) contain invisible characters.`);
  process.exit(1);
}

console.log(`${trackedPaths().length} tracked paths checked, none contain invisible characters.`);
