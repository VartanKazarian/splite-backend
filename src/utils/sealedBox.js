const crypto = require('crypto');

/**
 * Authenticated encryption for the secrets this system stores at rest.
 *
 * Two things qualify, and they arrived a year apart: a restaurant's bank API
 * credentials, and a staff member's TOTP secret. Both share every property that
 * matters -- a database dump must not yield a usable one, a modified ciphertext
 * must fail loudly rather than decrypt into something that works, and the
 * interesting moment is not the first encryption but the key rotation three
 * years in. So there is one implementation, configured twice, rather than two
 * that will drift.
 *
 * They deliberately do *not* share a key. A deployment with no payment
 * credentials must still be able to offer MFA, and a leaked payment key must
 * not also be a leaked authentication key.
 *
 * AES-256-GCM. GCM detects tampering, which is the property that matters for
 * data at rest: a silently altered credential is one that talks to somewhere
 * else, and a silently altered TOTP secret is an account whose codes an
 * attacker chose.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Base64 or hex, whichever the operator pasted. */
function decodeKey(material) {
  if (/^[0-9a-fA-F]{64}$/.test(material)) return Buffer.from(material, 'hex');
  return Buffer.from(material, 'base64');
}

/**
 * Builds a sealer over one key ring.
 *
 * `readKeys` and `readActiveVersion` are read lazily rather than captured,
 * because the app has to start without either secret store configured: most
 * deployments will have neither, and a missing key must break *storing a
 * secret* rather than break booting.
 *
 * `missing` and `unreadable` are the errors to raise, supplied by the caller so
 * each store keeps error codes its own clients already branch on.
 */
function createSealedBox({ envName, readKeys, readActiveVersion, missing, unreadable }) {
  let ring = null;

  function keyRing() {
    if (ring) return ring;

    const raw = String(readKeys() || '').trim();
    if (!raw) throw missing();

    const keys = new Map();
    for (const entry of raw.split(',')) {
      const [version, material] = entry.split(':');
      const parsed = Number(String(version).trim());
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${envName} has a bad version: ${version}`);
      }
      const key = decodeKey(String(material || '').trim());
      if (key.length !== KEY_BYTES) {
        throw new Error(`${envName} version ${parsed} must be ${KEY_BYTES} bytes`);
      }
      keys.set(parsed, key);
    }

    const active = readActiveVersion();
    if (!keys.has(active)) {
      throw new Error(`The active key version for ${envName} is ${active}, which is not in the ring`);
    }

    ring = { keys, active };
    return ring;
  }

  /**
   * Returns one buffer laid out as version ‖ iv ‖ tag ‖ ciphertext, so a row
   * carries everything needed to open it except the key. Keeping the version in
   * the blob as well as in its own column is deliberate redundancy: the column
   * is what a rotation job queries on, the prefix is what makes a blob
   * self-describing if it is ever copied somewhere the column did not follow.
   */
  function seal(value) {
    const { keys, active } = keyRing();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, keys.get(active), iv);

    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const version = Buffer.alloc(1);
    version.writeUInt8(active);

    return { blob: Buffer.concat([version, iv, tag, ciphertext]), keyVersion: active };
  }

  /**
   * Throws rather than returning null on a bad tag. A secret that fails
   * authentication is not a missing secret -- it is a modified one, and the
   * only safe response to that is to stop.
   */
  function open(blob) {
    const { keys } = keyRing();
    const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);

    if (buffer.length < 1 + IV_BYTES + TAG_BYTES + 1) throw unreadable('malformed');

    const version = buffer.readUInt8(0);
    const key = keys.get(version);
    if (!key) throw unreadable(`sealed with key version ${version}, which is not in the ring`);

    const iv = buffer.subarray(1, 1 + IV_BYTES);
    const tag = buffer.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = buffer.subarray(1 + IV_BYTES + TAG_BYTES);

    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch {
      // Deliberately not echoing the underlying error: it distinguishes a bad
      // tag from bad JSON, and that difference is useful to somebody probing.
      throw unreadable('could not be authenticated');
    }
  }

  return {
    seal,
    open,
    isCurrent(blob) {
      const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
      return buffer.length > 0 && buffer.readUInt8(0) === keyRing().active;
    },
    activeKeyVersion: () => keyRing().active,
    /** Testing seam: forces the ring to be re-read after the environment changes. */
    __resetRing: () => { ring = null; }
  };
}

module.exports = { createSealedBox, KEY_BYTES, IV_BYTES, TAG_BYTES };
