const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const config = require('../src/config');
const { PROVIDERS, SIGNATURE_HEADER, TIMESTAMP_HEADER } = require('../src/services/webhooks');
const { normaliseReference } = require('../src/services/paymentClaims');

const splite = PROVIDERS.SPLITE;

/** A request the way express hands one over, with rawBody captured by app.js. */
function fakeRequest({ body, rawBody, signature, timestamp }) {
  const headers = {
    [SIGNATURE_HEADER]: signature,
    [TIMESTAMP_HEADER]: timestamp === undefined ? String(now()) : timestamp
  };
  return {
    body,
    rawBody,
    get: name => headers[String(name).toLowerCase()]
  };
}

const now = () => Math.floor(Date.now() / 1000);

const sign = (timestamp, rawBody) =>
  crypto.createHmac('sha256', config.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');

const signedRequest = (payload, { timestamp = now(), mutate } = {}) => {
  const rawBody = JSON.stringify(payload);
  const signature = sign(timestamp, rawBody);
  return fakeRequest({
    body: payload,
    rawBody: mutate ? mutate(rawBody) : rawBody,
    signature,
    timestamp: String(timestamp)
  });
};

test('a correctly signed delivery is accepted', () => {
  assert.doesNotThrow(() => splite.authenticate(signedRequest({ id: 'x', status: 'SUCCEEDED' })));
});

test('the signature covers the raw bytes, not the parsed object', () => {
  // The bug this exists to catch: verifying against JSON.stringify(req.body)
  // instead of the bytes received. These two bodies parse to the same object
  // and have different signatures, so a re-serialising implementation accepts
  // a body it never authenticated.
  const timestamp = now();
  const received = '{"status":"SUCCEEDED","id":"abc"}';
  const reserialised = JSON.stringify(JSON.parse(received));
  assert.notEqual(received, reserialised, 'key order must actually differ for this test to mean anything');

  const req = fakeRequest({
    body: JSON.parse(received),
    rawBody: received,
    signature: sign(timestamp, received),
    timestamp: String(timestamp)
  });
  assert.doesNotThrow(() => splite.authenticate(req));

  // And a signature computed over the re-serialised form must not pass.
  const wrong = fakeRequest({
    body: JSON.parse(received),
    rawBody: received,
    signature: sign(timestamp, reserialised),
    timestamp: String(timestamp)
  });
  assert.throws(() => splite.authenticate(wrong), err => err.code === 'WEBHOOK_SIGNATURE_INVALID');
});

test('a body edited after signing is rejected', () => {
  const req = signedRequest({ id: 'x', status: 'SUCCEEDED' }, {
    mutate: raw => raw.replace('SUCCEEDED', 'FAILED')
  });
  assert.throws(() => splite.authenticate(req), err => err.code === 'WEBHOOK_SIGNATURE_INVALID');
});

test('the timestamp is inside the MAC, so it cannot be moved', () => {
  // Replay defence is worthless if an attacker can take a captured signature
  // and simply put a fresh timestamp beside it.
  const timestamp = now();
  const rawBody = JSON.stringify({ id: 'x', status: 'SUCCEEDED' });
  const req = fakeRequest({
    body: { id: 'x', status: 'SUCCEEDED' },
    rawBody,
    signature: sign(timestamp, rawBody),
    timestamp: String(timestamp + 1)
  });
  assert.throws(() => splite.authenticate(req), err => err.code === 'WEBHOOK_SIGNATURE_INVALID');
});

test('a stale delivery is rejected before the signature is even compared', () => {
  const stale = now() - (config.webhookToleranceSeconds + 60);
  assert.throws(
    () => splite.authenticate(signedRequest({ id: 'x' }, { timestamp: stale })),
    err => err.code === 'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE'
  );
});

test('missing headers are their own error, not a signature mismatch', () => {
  const rawBody = '{}';
  assert.throws(
    () => splite.authenticate(fakeRequest({ body: {}, rawBody, signature: undefined })),
    err => err.code === 'WEBHOOK_SIGNATURE_MISSING'
  );
});

test('no raw body means nothing can be verified, so nothing is accepted', () => {
  // Fails closed. If the parser did not capture the bytes there is no honest
  // way to check the signature, and guessing is how a forged delivery gets in.
  const timestamp = now();
  assert.throws(
    () => splite.authenticate(fakeRequest({
      body: { id: 'x' }, rawBody: undefined, signature: sign(timestamp, '{}'), timestamp: String(timestamp)
    })),
    err => err.code === 'WEBHOOK_BODY_UNVERIFIABLE'
  );
});

test('the parser reads only what it can attribute', () => {
  const parsed = splite.parse({
    id: 'prov_1',
    status: 'completed',
    amountVes: '12600',
    metadata: { splitePaymentId: 'p-1', restaurantId: 'r-1' }
  });
  assert.equal(parsed.providerPaymentId, 'prov_1');
  assert.equal(parsed.paymentId, 'p-1');
  assert.equal(parsed.restaurantId, 'r-1');
  assert.equal(parsed.succeeded, true);
  assert.equal(parsed.failed, false);
});

test('an unknown status settles nothing rather than defaulting either way', () => {
  const parsed = splite.parse({ id: 'x', status: 'under_review' });
  assert.equal(parsed.succeeded, false);
  assert.equal(parsed.failed, false);
});

test('references normalise to digits, so one reference cannot claim two bills', () => {
  // The unique index in migration 014 is on the stored value. If spellings
  // normalised differently, table B could re-declare table A's reference just
  // by adding a dash.
  for (const spelling of ['0001234567', '000 123 4567', '000-123-4567', 'ref 0001234567']) {
    assert.equal(normaliseReference(spelling), '0001234567', spelling);
  }
});
