const config = require('../config');
const { ApiError } = require('../errors');

/**
 * Encryption for bank API credentials.
 *
 * These are the only values in the system that let something move a
 * restaurant's money, and they are handed to us by the restaurant rather than
 * generated, so they cannot be rotated by us if they leak. That sets the bar:
 * a database dump must not yield usable credentials, and neither must a log
 * line, an error message or an API response.
 *
 * AES-256-GCM, not the AES-128-ECB Mercantil's own field encryption uses. ECB
 * is deterministic and unauthenticated -- fine to implement when a counterparty
 * specifies it for a phone number in a request body, wrong for something we
 * choose ourselves for data at rest. GCM detects tampering, which matters here:
 * a silently altered ciphertext should fail loudly rather than decrypt into a
 * credential that talks to somewhere else.
 *
 * Keys live in a ring rather than a variable, because the interesting moment is
 * not the first encryption but the rotation three years in. Every row records
 * the version that sealed it, so a new key can be introduced and old rows
 * re-sealed in the background instead of in one migration that must not fail.
 */

const { createSealedBox, KEY_BYTES } = require('../utils/sealedBox');

/**
 * The cipher, the blob layout and the key-ring parsing are shared with the
 * other secret this system stores at rest -- see `src/utils/sealedBox.js`. What
 * stays here is what is specific to bank credentials: which environment
 * variable holds the ring, and the error codes clients already branch on.
 */
const box = createSealedBox({
  envName: 'PAYMENT_CREDENTIALS_KEYS',
  readKeys: () => config.payments.credentialKeys,
  readActiveVersion: () => config.payments.activeKeyVersion,
  missing: () => new ApiError(
    'PAYMENT_CREDENTIALS_KEY_MISSING',
    'PAYMENT_CREDENTIALS_KEYS is not configured, so bank credentials cannot be stored or read'
  ),
  unreadable: reason => new ApiError(
    'PAYMENT_CREDENTIALS_UNREADABLE',
    reason === 'malformed'
      ? 'Stored credentials are malformed'
      : `Stored credentials ${reason}`
  )
});

const { seal, open, isCurrent, activeKeyVersion, __resetRing } = box;

module.exports = { seal, open, isCurrent, activeKeyVersion, __resetRing, KEY_BYTES };
