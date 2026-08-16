const Joi = require('joi');
const db = require('../connectors/base');
const { ApiError } = require('../errors');
const { seal, open, isCurrent, activeKeyVersion } = require('./credentials');
const { logger } = require('../connectors/logger');

/**
 * Storing and reading bank API credentials.
 *
 * The shape of a credential set is per provider and always will be: Mercantil
 * issues a merchant id, client id, secret key, integrator id and terminal id;
 * the next bank will issue a different number of differently named things. So
 * the shape lives in a registry here, one entry per provider, and the database
 * stores an opaque sealed blob. Adding a bank is an entry in this object.
 *
 * Nothing in this module returns plaintext except `loadCredentials`, which
 * exists for an adapter to call and is deliberately not reachable from any
 * route. Everything a route can see is booleans and timestamps.
 */

/**
 * What each provider needs, and nothing more.
 *
 * `unknown(false)` matters as much as the required fields: a credential blob
 * that quietly carries whatever the caller sent is a place for a stray password
 * to end up, sealed forever and invisible to review.
 */
const CREDENTIAL_SCHEMAS = {
  MERCANTIL: Joi.object({
    merchantId: Joi.string().trim().min(1).max(64).required(),
    clientId: Joi.string().trim().min(1).max(128).required(),
    secretKey: Joi.string().trim().min(1).max(256).required(),
    integratorId: Joi.string().trim().min(1).max(64).required(),
    terminalId: Joi.string().trim().min(1).max(64).required()
  }).unknown(false)
};

const PROVIDERS = Object.freeze(Object.keys(CREDENTIAL_SCHEMAS));

/** Public metadata. Never the credentials, and there is no option to include them. */
const CONFIG_COLUMNS = `restaurant_id, provider, enabled, key_version,
                        credentials_validated_at, created_at, updated_at`;

function schemaFor(provider) {
  const schema = CREDENTIAL_SCHEMAS[provider];
  if (!schema) {
    throw new ApiError('PAYMENT_PROVIDER_UNKNOWN', 'No adapter for that provider', {
      provider,
      supported: PROVIDERS
    });
  }
  return schema;
}

/**
 * Stores or replaces a restaurant's credentials for one provider.
 *
 * Replacing resets `credentials_validated_at` and forces `enabled` off. New
 * credentials are unproven credentials, however good the old ones were: pasting
 * a mistyped secret key over a working one must not leave a rail switched on
 * and quietly broken, which is the failure the CHECK in migration 018 exists to
 * make impossible.
 */
async function putCredentials({ restaurantId, provider, credentials }) {
  const { value, error } = schemaFor(provider).validate(credentials, { abortEarly: false });
  if (error) {
    throw new ApiError('VALIDATION_FAILED', 'Credentials are not valid for that provider', {
      fields: error.details.map(d => d.message)
    });
  }

  const { blob, keyVersion } = seal(value);

  const { rows } = await db.query(
    `INSERT INTO payment_provider_configs
       (restaurant_id, provider, credentials_encrypted, key_version, enabled, credentials_validated_at)
     VALUES ($1, $2, $3, $4, FALSE, NULL)
     ON CONFLICT (restaurant_id, provider) DO UPDATE
       SET credentials_encrypted = EXCLUDED.credentials_encrypted,
           key_version = EXCLUDED.key_version,
           enabled = FALSE,
           credentials_validated_at = NULL
     RETURNING ${CONFIG_COLUMNS}`,
    [restaurantId, provider, blob, keyVersion]
  );

  // The event, never the values. An audit trail is read by more people and kept
  // longer than the row it describes.
  logger.info(
    { event: 'PAYMENT_CREDENTIALS_STORED', restaurantId, provider, keyVersion },
    'Bank credentials stored'
  );

  return rows[0];
}

/** Configs for a restaurant, as a route may see them. */
async function listConfigs(restaurantId) {
  const { rows } = await db.query(
    `SELECT ${CONFIG_COLUMNS} FROM payment_provider_configs
      WHERE restaurant_id = $1 ORDER BY provider`,
    [restaurantId]
  );
  return rows;
}

async function deleteConfig({ restaurantId, provider }) {
  const { rowCount } = await db.query(
    'DELETE FROM payment_provider_configs WHERE restaurant_id = $1 AND provider = $2',
    [restaurantId, provider]
  );
  if (!rowCount) throw new ApiError('PAYMENT_PROVIDER_UNKNOWN', 'No configuration for that provider', { provider });

  logger.info({ event: 'PAYMENT_CREDENTIALS_DELETED', restaurantId, provider }, 'Bank credentials deleted');
}

/**
 * Marks credentials as proven, which is what allows a rail to be switched on.
 *
 * Takes the result of a real call to the bank. There is no route for this and
 * there should not be: "these credentials work" is a fact an adapter
 * establishes by using them, not a checkbox somebody ticks.
 */
async function markValidated({ restaurantId, provider, enable = false }) {
  const { rows } = await db.query(
    `UPDATE payment_provider_configs
        SET credentials_validated_at = NOW(), enabled = $3
      WHERE restaurant_id = $1 AND provider = $2
      RETURNING ${CONFIG_COLUMNS}`,
    [restaurantId, provider, enable]
  );
  if (!rows.length) throw new ApiError('PAYMENT_PROVIDER_UNKNOWN', 'No configuration for that provider', { provider });
  return rows[0];
}

/**
 * The plaintext, for an adapter about to call a bank.
 *
 * The one function here that returns secrets. It is not reachable from a route,
 * it takes no formatting options, and it returns the object rather than
 * anything printable -- so the shortest path from here to a log line is a
 * deliberate one somebody has to write.
 */
async function loadCredentials({ restaurantId, provider }) {
  const { rows } = await db.query(
    `SELECT credentials_encrypted, enabled FROM payment_provider_configs
      WHERE restaurant_id = $1 AND provider = $2`,
    [restaurantId, provider]
  );
  if (!rows.length) {
    throw new ApiError('PAYMENT_PROVIDER_UNKNOWN', 'No credentials for that provider', { provider });
  }
  return { credentials: open(rows[0].credentials_encrypted), enabled: rows[0].enabled };
}

/**
 * Re-seals everything not under the current key.
 *
 * The reason `key_version` is a column rather than only a prefix inside the
 * blob: this can find its work with an index instead of decrypting every row to
 * ask. Rotation is add a key, point the active version at it, run this.
 */
async function rotate({ batch = 100 } = {}) {
  const target = activeKeyVersion();
  const { rows } = await db.query(
    `SELECT restaurant_id, provider, credentials_encrypted
       FROM payment_provider_configs
      WHERE key_version <> $1
      LIMIT $2`,
    [target, batch]
  );

  let resealed = 0;
  for (const row of rows) {
    if (isCurrent(row.credentials_encrypted)) continue;
    const { blob, keyVersion } = seal(open(row.credentials_encrypted));
    await db.query(
      `UPDATE payment_provider_configs
          SET credentials_encrypted = $3, key_version = $4
        WHERE restaurant_id = $1 AND provider = $2`,
      [row.restaurant_id, row.provider, blob, keyVersion]
    );
    resealed++;
  }

  if (resealed) {
    logger.info({ event: 'PAYMENT_CREDENTIALS_ROTATED', resealed, keyVersion: target }, 'Credentials re-sealed');
  }
  return { resealed, remaining: rows.length - resealed };
}

module.exports = {
  putCredentials, listConfigs, deleteConfig, markValidated, loadCredentials, rotate,
  PROVIDERS, CREDENTIAL_SCHEMAS
};
