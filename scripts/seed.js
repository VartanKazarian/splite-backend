const db = require('../src/connectors/base');
const { hashPassword } = require('../src/services/auth');

/**
 * Idempotent development seed. Re-running it updates the owner's password
 * rather than creating a second restaurant.
 */
async function run() {
  const email = process.env.SEED_OWNER_EMAIL;
  const password = process.env.SEED_OWNER_PASSWORD;
  const restaurantName = process.env.SEED_RESTAURANT_NAME || 'Splite Demo Restaurant';

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_SEED !== 'true') {
    throw new Error('Refusing to seed in production without ALLOW_PRODUCTION_SEED=true');
  }
  if (!email || !password) throw new Error('SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD are required');
  if (password.length < 12) throw new Error('SEED_OWNER_PASSWORD must be at least 12 characters');
  if (/replace-with/i.test(password)) throw new Error('SEED_OWNER_PASSWORD is still the example placeholder');

  const passwordHash = await hashPassword(password);

  const restaurantId = await db.withTransaction(async client => {
    const existing = await client.query('SELECT id FROM restaurants WHERE name = $1', [restaurantName]);
    const id = existing.rows.length
      ? existing.rows[0].id
      : (await client.query('INSERT INTO restaurants (name) VALUES ($1) RETURNING id', [restaurantName])).rows[0].id;

    await client.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'OWNER')
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL
       DO UPDATE SET password_hash = EXCLUDED.password_hash, active = TRUE`,
      [id, email.toLowerCase(), passwordHash]
    );

    await client.query(
      `INSERT INTO tables (restaurant_id, name) VALUES ($1, 'T1'), ($1, 'T2')
       ON CONFLICT (restaurant_id, name) DO NOTHING`,
      [id]
    );

    return id;
  });

  console.log('Seeded owner for restaurant', restaurantId);
}

run()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch(async err => {
    console.error('[Seed]', err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
