#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Writes the OpenAPI document to openapi.json at the repository root.
 *
 *   npm run openapi:dump     regenerate the file
 *   npm run openapi:check    fail if the committed file is stale
 *
 * The spec is committed rather than only served, so a frontend can generate its
 * client from a file in git without the API running anywhere:
 *
 *   npx openapi-typescript openapi.json -o src/api.d.ts
 *
 * The check runs in CI, so the committed artifact cannot drift from the code
 * that produces it -- the same reason test/openapi.test.js exists.
 */

const { document } = require('../src/openapi');

const OUT = path.join(__dirname, '..', 'openapi.json');
const serialised = JSON.stringify(document, null, 2) + '\n';

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT)) {
    console.error('openapi.json is missing. Run `npm run openapi:dump` and commit it.');
    process.exit(1);
  }
  if (fs.readFileSync(OUT, 'utf8') !== serialised) {
    console.error('openapi.json is stale. Run `npm run openapi:dump` and commit the result.');
    process.exit(1);
  }
  console.log('openapi.json matches the code.');
} else {
  fs.writeFileSync(OUT, serialised);
  const operations = Object.values(document.paths)
    .flatMap(item => Object.keys(item))
    .filter(m => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).length;
  console.log(`Wrote openapi.json — ${operations} operations, version ${document.info.version}.`);
}
