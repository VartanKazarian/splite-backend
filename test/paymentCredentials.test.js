const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const config = require('../src/config');
const credentials = require('../src/payments/credentials');

const KEY_1 = crypto.randomBytes(32).toString('base64');
const KEY_2 = crypto.randomBytes(32).toString('base64');

const SECRET = {
  merchantId: 'M-1', clientId: 'C-1', secretKey: 'the-secret-key',
  integratorId: 'I-1', terminalId: 'T-1'
};

const useRing = (keys, active) => {
  config.payments.credentialKeys = keys;
  config.payments.activeKeyVersion = active;
  credentials.__resetRing();
};

const original = { ...config.payments };

beforeEach(() => useRing(`1:${KEY_1}`, 1));
afterEach(() => { Object.assign(config.payments, original); credentials.__resetRing(); });

test('a sealed blob contains no readable trace of the secret', () => {
  // The property a database dump depends on.
  const { blob } = credentials.seal(SECRET);
  const asText = blob.toString('utf8');
  const asBase64 = blob.toString('base64');

  for (const value of Object.values(SECRET)) {
    assert.ok(!asText.includes(value), `plaintext leaked: ${value}`);
    assert.ok(!asBase64.includes(Buffer.from(value).toString('base64').replace(/=+$/, '')), value);
  }
});

test('round-trips exactly', () => {
  const { blob } = credentials.seal(SECRET);
  assert.deepEqual(credentials.open(blob), SECRET);
});

test('the same secret seals differently every time', () => {
  // A fresh IV per seal. Without it, equal credentials produce equal
  // ciphertext, and a dump reveals which restaurants share a merchant id.
  const a = credentials.seal(SECRET).blob.toString('base64');
  const b = credentials.seal(SECRET).blob.toString('base64');
  assert.notEqual(a, b);
});

test('a single altered byte is refused, not decrypted', () => {
  // GCM authenticates. A silently modified credential that still decrypts is
  // one that could be made to talk to somewhere else.
  const { blob } = credentials.seal(SECRET);
  for (const index of [0, 5, 20, blob.length - 1]) {
    const tampered = Buffer.from(blob);
    tampered[index] ^= 0x01;
    assert.throws(
      () => credentials.open(tampered),
      err => err.code === 'PAYMENT_CREDENTIALS_UNREADABLE',
      `byte ${index} was accepted`
    );
  }
});

test('the wrong key cannot open it', () => {
  const { blob } = credentials.seal(SECRET);
  useRing(`1:${KEY_2}`, 1);
  assert.throws(() => credentials.open(blob), err => err.code === 'PAYMENT_CREDENTIALS_UNREADABLE');
});

test('a key still in the ring opens an old blob after rotation', () => {
  // The whole reason for a ring: adding a key must not orphan what is already
  // stored, or rotation becomes one migration that must not fail.
  const { blob, keyVersion } = credentials.seal(SECRET);
  assert.equal(keyVersion, 1);

  useRing(`1:${KEY_1},2:${KEY_2}`, 2);

  assert.deepEqual(credentials.open(blob), SECRET, 'old rows must keep opening');
  assert.equal(credentials.isCurrent(blob), false, 'and be recognisable as needing re-sealing');

  const resealed = credentials.seal(SECRET);
  assert.equal(resealed.keyVersion, 2);
  assert.ok(credentials.isCurrent(resealed.blob));
  assert.deepEqual(credentials.open(resealed.blob), SECRET);
});

test('a blob whose key has left the ring fails loudly', () => {
  const { blob } = credentials.seal(SECRET);
  useRing(`2:${KEY_2}`, 2);
  assert.throws(
    () => credentials.open(blob),
    err => err.code === 'PAYMENT_CREDENTIALS_UNREADABLE'
  );
});

test('no key configured is a configuration error, not a crash', () => {
  // Most deployments never store bank credentials, so a missing key must break
  // storing them and nothing else.
  useRing('', 1);
  assert.throws(
    () => credentials.seal(SECRET),
    err => err.code === 'PAYMENT_CREDENTIALS_KEY_MISSING'
  );
});

test('a key of the wrong length is rejected at parse, not at use', () => {
  useRing(`1:${crypto.randomBytes(16).toString('base64')}`, 1);
  assert.throws(() => credentials.seal(SECRET), /32 bytes/);
});

test('an active version missing from the ring is rejected', () => {
  useRing(`1:${KEY_1}`, 3);
  assert.throws(() => credentials.seal(SECRET), /not in the ring/);
});

test('accepts a key as hex or base64, whichever was pasted', () => {
  const raw = crypto.randomBytes(32);
  for (const encoding of ['hex', 'base64']) {
    useRing(`1:${raw.toString(encoding)}`, 1);
    assert.deepEqual(credentials.open(credentials.seal(SECRET).blob), SECRET, encoding);
  }
});

test('the DTO has no field that could carry a secret', () => {
  const dto = require('../src/dto');
  const view = dto.paymentProviderConfig({
    provider: 'MERCANTIL', enabled: false,
    credentials_validated_at: null, updated_at: new Date(),
    // Present on the row, and must not survive the mapper.
    credentials_encrypted: Buffer.from('sealed'), key_version: 1
  });

  assert.deepEqual(
    Object.keys(view).sort(),
    ['configured', 'credentialsValidatedAt', 'enabled', 'provider', 'updatedAt']
  );
  assert.ok(!JSON.stringify(view).includes('sealed'));
  // Not even the key version: which key sealed a row is operational detail with
  // no use outside the rotation job.
  assert.equal(view.keyVersion, undefined);
});

test('a provider credential set rejects fields nobody asked for', () => {
  // unknown(false). A blob that carries whatever the caller sent is where a
  // stray password ends up, sealed forever and invisible to review.
  const { CREDENTIAL_SCHEMAS } = require('../src/payments/providerConfigs');
  const { error } = CREDENTIAL_SCHEMAS.MERCANTIL.validate({ ...SECRET, password: 'oops' });
  assert.ok(error, 'unexpected fields must not be sealed');
});
