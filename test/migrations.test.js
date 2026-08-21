const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'migrations');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

/**
 * There are no down migrations, and this is what stands in for them.
 *
 * Writing thirty reverse scripts would have been the obvious answer and the
 * wrong one: most of them are not honestly reversible -- dropping a column back
 * loses the data in it -- and a set of scripts nobody has ever run is a set of
 * scripts that does not work. What actually makes a rollback possible is the
 * property below.
 *
 * **A migration must leave a schema the previous release's code can still run
 * against.** Hold that, and rolling back is redeploying the previous image and
 * nothing else. Break it, and the only way back is a backup.
 *
 * So a file that breaks it has to say so, in the file, where somebody writing
 * the next one will see it. Three do, and all three predate the first
 * deployment.
 */

const DESTRUCTIVE = [
  [/\bDROP\s+TABLE\b/i, 'drops a table'],
  [/\bDROP\s+COLUMN\b/i, 'drops a column'],
  [/\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, 'changes a column type'],
  [/\bALTER\s+COLUMN\b[^;]*\bSET\s+NOT\s+NULL\b/i, 'adds NOT NULL to an existing column'],
  [/\bRENAME\b/i, 'renames something'],
  [/\bTRUNCATE\b/i, 'truncates a table'],
  [/\bDELETE\s+FROM\b/i, 'deletes rows']
];

/** Comments describe; only statements do anything. */
const statements = sql => sql
  .split('\n')
  .filter(line => !line.trim().startsWith('--'))
  .join('\n');

test('every migration is backward compatible, or says why it is not', () => {
  const offenders = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
    if (raw.includes('NOT-BACKWARD-COMPATIBLE')) continue;

    const body = statements(raw);
    for (const [pattern, what] of DESTRUCTIVE) {
      if (pattern.test(body)) offenders.push(`${file} ${what}`);
    }
  }

  assert.deepEqual(offenders, [], [
    'These migrations would strand the previous release:',
    ...offenders.map(o => `  - ${o}`),
    '',
    'Either split the change so the old code still runs -- add the new column,',
    'backfill, and drop the old one a release later -- or mark the file',
    'NOT-BACKWARD-COMPATIBLE with the reason, which says out loud that rolling',
    'back past it needs a backup rather than a redeploy.'
  ].join('\n'));
});

test('the ones that are not backward compatible are the three that predate the product', () => {
  // Pinned deliberately. A fourth appearing is a decision somebody should have
  // to make on purpose, and it should show up here rather than in an incident.
  const marked = files.filter(f =>
    fs.readFileSync(path.join(DIR, f), 'utf8').includes('NOT-BACKWARD-COMPATIBLE'));

  assert.deepEqual(marked, [
    '006_fx_value_date.sql',
    '008_ves_settlement_columns.sql',
    '009_fx_rate_precision.sql'
  ]);
});

test('migrations are numbered without gaps or collisions', () => {
  // The runner applies them in filename order and records what it applied, so
  // two files sharing a number would apply in an order that depends on the rest
  // of the name.
  const numbers = files.map(f => Number(f.slice(0, 3)));
  const seen = new Set();
  for (const n of numbers) {
    assert.ok(!seen.has(n), `two migrations share number ${n}`);
    seen.add(n);
  }
  for (let i = 1; i < numbers.length; i++) {
    assert.equal(numbers[i], numbers[i - 1] + 1, `a gap before ${files[i]}`);
  }
});

test('every migration is safe to re-run against a database that has it', () => {
  // The runner skips a file it has already applied, so this is not about the
  // normal path. It is about the one where somebody restores a database and
  // replays, and about a fresh environment catching up: CREATE without
  // IF NOT EXISTS turns that into an error somebody has to reason about at the
  // worst moment.
  const missing = [];
  for (const file of files) {
    const body = statements(fs.readFileSync(path.join(DIR, file), 'utf8'));
    for (const m of body.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\b(?!\s+IF\s+NOT\s+EXISTS)/gi)) {
      missing.push(`${file}: CREATE ${m[1]} without IF NOT EXISTS`);
    }
  }
  assert.deepEqual(missing, []);
});
