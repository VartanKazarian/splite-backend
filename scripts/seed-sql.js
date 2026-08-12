#!/usr/bin/env node
'use strict';

const argon2 = require('argon2');
const crypto = require('node:crypto');
const { loginSchema } = require('../src/middleware/schemas');

/**
 * Prints the SQL to create a first owner, for pasting into a database console.
 *
 *   SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD='…' npm run --silent seed:sql
 *
 * Use --silent when redirecting to a file: npm prints its own
 * "> package@version script" banner on stdout, which lands in the .sql and
 * fails with a syntax error at '>'.
 *
 * `npm run seed` connects to the database itself and is the better tool when
 * you can reach it. This exists for when you cannot: a managed Postgres with
 * no public networking, where the only way in is the provider's own SQL
 * console. Exposing the database to the internet purely to create one row is a
 * worse trade than pasting a statement.
 *
 * The output contains an Argon2id *hash*, never the password, so it is safe to
 * paste into a web console. The hash encodes its own parameters, so the login
 * path verifies it without needing to know how it was produced.
 */

const email = process.env.SEED_OWNER_EMAIL;
const password = process.env.SEED_OWNER_PASSWORD;
const restaurantName = process.env.SEED_RESTAURANT_NAME || 'Splite Demo';

if (!email || !password) {
  console.error('SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD are required.');
  process.exit(2);
}
if (password.length < 12) {
  console.error('SEED_OWNER_PASSWORD must be at least 12 characters.');
  process.exit(2);
}
// The same rule /auth/login applies, so this cannot create an account that can
// never sign in.
const { error } = loginSchema.validate({ email, password });
if (error) {
  console.error(`SEED_OWNER_EMAIL would be rejected at login: ${error.details.map(d => d.message).join('; ')}`);
  process.exit(2);
}

/** Single-quoted for SQL. Neither value is attacker-controlled, but still. */
const quote = value => `'${String(value).replace(/'/g, "''")}'`;

argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
  .then(hash => {
    console.log(`
-- Splite: create the first restaurant and its owner.
-- Contains a password hash, not the password. Safe to paste into a SQL console.
-- Idempotent: re-running resets this owner's password and adds no second restaurant.

WITH upserted_restaurant AS (
  INSERT INTO restaurants (name, menu_currency)
  VALUES (${quote(restaurantName)}, 'VES')
  ON CONFLICT DO NOTHING
  RETURNING id
), restaurant AS (
  SELECT id FROM upserted_restaurant
  UNION ALL
  SELECT id FROM restaurants WHERE name = ${quote(restaurantName)}
  LIMIT 1
)
INSERT INTO users (restaurant_id, email, password_hash, role)
SELECT id, ${quote(email.toLowerCase())}, ${quote(hash)}, 'OWNER' FROM restaurant
ON CONFLICT (lower(email)) WHERE email IS NOT NULL
DO UPDATE SET password_hash = EXCLUDED.password_hash, active = TRUE;

-- Two tables to start with, so a bill can be opened immediately.
INSERT INTO tables (restaurant_id, name)
SELECT id, t.name FROM restaurants, (VALUES ('T1'), ('T2')) AS t(name)
WHERE restaurants.name = ${quote(restaurantName)}
ON CONFLICT (restaurant_id, name) DO NOTHING;

-- Confirm:
SELECT u.email, u.role, u.active, r.name AS restaurant
  FROM users u JOIN restaurants r ON r.id = u.restaurant_id;
`);
  })
  .catch(err => { console.error(err.message); process.exit(1); });
