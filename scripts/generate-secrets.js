#!/usr/bin/env node
'use strict';

const { randomBytes } = require('node:crypto');

/**
 * Prints the four secrets the app requires in production.
 *
 * Run this yourself and paste the values straight into the hosting provider.
 * Nothing writes them to disk, and nothing here logs them anywhere else --
 * a secret that lands in a file or a chat log has to be treated as burned.
 *
 *   npm run secrets
 *
 * 512 bits each. These sign access tokens, refresh tokens, table QR payloads
 * and webhook callbacks; all four are independent, so rotating one does not
 * invalidate the others.
 */

const SECRETS = [
  ['JWT_ACCESS_SECRET', 'signs short-lived staff access tokens'],
  ['JWT_REFRESH_SECRET', 'signs refresh tokens; rotating it logs everyone out'],
  ['QR_SIGNING_SECRET', 'signs table QR payloads; rotating it invalidates printed codes'],
  ['WEBHOOK_SECRET', 'verifies inbound payment callbacks']
];

const width = Math.max(...SECRETS.map(([name]) => name.length));

console.log('\nPaste these into your hosting provider\'s variables. Do not commit them.\n');

for (const [name, purpose] of SECRETS) {
  console.log(`# ${purpose}`);
  console.log(`${name.padEnd(width)}=${randomBytes(64).toString('base64url')}\n`);
}

console.log('Generated fresh on every run -- re-running gives different values,');
console.log('so capture these before closing the terminal.\n');
