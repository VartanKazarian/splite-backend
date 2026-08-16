const crypto = require('crypto');
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

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96 bits, the size GCM is defined for
const KEY_BYTES = 32;

let ring = null;

/**
 * Parses PAYMENT_CREDENTIALS_KEYS, `version:material` comma separated.
 *
 * Resolved on first use, never at import: the app has to start without payment
 * credentials configured, because most deployments will not have them and a
 * missing key must break storing credentials rather than break booting.
 */
function keyRing() {
  if (ring) return ring;

  const raw = String(config.payments.credentialKeys || '').trim();
  if (!raw) {
    throw new ApiError(
      'PAYMENT_CREDENTIALS_KEY_MISSING',
      'PAYMENT_CREDENTIALS_KEYS is not configured, so bank credentials cannot be stored or read'
    );
  }

  const keys = new Map();
  for (const entry of raw.split(',')) {
    const [version, material] = entry.split(':');
    const parsed = Number(String(version).trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`PAYMENT_CREDENTIALS_KEYS has a bad version: ${version}`);
    }

    const key = decodeKey(String(material || '').trim());
    if (key.length !== KEY_BYTES) {
      throw new Error(`PAYMENT_CREDENTIALS_KEYS version ${parsed} must be ${KEY_BYTES} bytes`);
    }
    keys.set(parsed, key);
  }

  const active = config.payments.activeKeyVersion;
  if (!keys.has(active)) {
    throw new Error(`PAYMENT_CREDENTIALS_ACTIVE_KEY_VERSION is ${active}, which is not in the ring`);
  }

  ring = { keys, active };
  return ring;
}

/** Base64 or hex, whichever the operator pasted. */
function decodeKey(material) {
  if (/^[0-9a-fA-F]{64}$/.test(material)) return Buffer.from(material, 'hex');
  return Buffer.from(material, 'base64');
}

/**
 * Seals a credential object.
 *
 * Returns one buffer laid out as version ‖ iv ‖ tag ‖ ciphertext, so a row
 * carries everything needed to open it except the key. Keeping the version in
 * the blob as well as in its own column is deliberate redundancy: the column is
 * what a rotation job queries on, the prefix is what makes a blob
 * self-describing if it is ever copied somewhere the column did not follow.
 */
function seal(credentials) {
  const { keys, active } = keyRing();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keys.get(active), iv);

  const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const version = Buffer.alloc(1);
  version.writeUInt8(active);

  return { blob: Buffer.concat([version, iv, tag, ciphertext]), keyVersion: active };
}

/**
 * Opens a sealed credential blob.
 *
 * Throws rather than returning null on a bad tag. A credential that fails
 * authentication is not a missing credential -- it is a modified one, and the
 * only safe response to that is to stop.
 */
function open(blob) {
  const { keys } = keyRing();
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);

  if (buffer.length < 1 + IV_BYTES + 16 + 1) {
    throw new ApiError('PAYMENT_CREDENTIALS_UNREADABLE', 'Stored credentials are malformed');
  }

  const version = buffer.readUInt8(0);
  const key = keys.get(version);
  if (!key) {
    throw new ApiError(
      'PAYMENT_CREDENTIALS_UNREADABLE',
      `Stored credentials were sealed with key version ${version}, which is not in the ring`
    );
  }

  const iv = buffer.subarray(1, 1 + IV_BYTES);
  const tag = buffer.subarray(1 + IV_BYTES, 1 + IV_BYTES + 16);
  const ciphertext = buffer.subarray(1 + IV_BYTES + 16);

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    // Deliberately not echoing the underlying error: it distinguishes a bad tag
    // from bad JSON, and that difference is useful to somebody probing.
    throw new ApiError(
      'PAYMENT_CREDENTIALS_UNREADABLE',
      'Stored credentials could not be authenticated'
    );
  }
}

/** Whether a blob is already sealed with the active key. Used by rotation. */
function isCurrent(blob) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return buffer.length > 0 && buffer.readUInt8(0) === keyRing().active;
}

const activeKeyVersion = () => keyRing().active;

/** Testing seam: forces the ring to be re-read after the environment changes. */
const __resetRing = () => { ring = null; };

module.exports = { seal, open, isCurrent, activeKeyVersion, __resetRing, KEY_BYTES };
