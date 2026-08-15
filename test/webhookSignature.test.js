const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const config = require('../src/config');
const { redis } = require('../src/connectors/redis');
const { PROVIDERS, SIGNATURE_HEADER, TIMESTAMP_HEADER } = require('../src/services/webhooks');
const { normaliseReference } = require('../src/services/paymentClaims');

/**
 * The SPLITE provider's verifier is the middleware from
 * src/middleware/webhookSignature.js, so this exercises the real thing rather
 * than a second copy of the same rules.
 *
 * Replay protection is stubbed out here: it is Redis-backed and this is the
 * unit suite, which runs offline. `test/integration/` is where single-use is
 * proven against a live store.
 */
redis.set = async () => 'OK';

const verify = req => new Promise((resolve, reject) => {
  PROVIDERS.SPLITE.verify(req, {}, err => (err ? reject(err) : resolve()));
});

/** Asserts the middleware rejected with a particular error code. */
async function rejectsWith(req, code) {
  await assert.rejects(() => verify(req), err => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
    return true;
  });
}

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

test('a correctly signed delivery is accepted', async () => {
  await verify(signedRequest({ id: 'x', status: 'SUCCEEDED' }));
});

test('the signature covers the raw bytes, not the parsed object', async () => {
  // The bug this exists to catch: verifying against JSON.stringify(req.body)
  // instead of the bytes received. These two bodies parse to the same object
  // and have different signatures, so a re-serialising implementation accepts
  // a body it never authenticated.
  const timestamp = now();
  // Spaced the way a provider that pretty-prints its payloads sends it. Key
  // *order* survives a JSON round trip, so reordering keys would not have
  // demonstrated anything -- whitespace is the difference that actually occurs
  // and that a re-serialising verifier destroys.
  const received = '{"status": "SUCCEEDED", "id": "abc"}';
  const reserialised = JSON.stringify(JSON.parse(received));
  assert.notEqual(received, reserialised, 'the two forms must differ for this test to mean anything');

  const req = fakeRequest({
    body: JSON.parse(received),
    rawBody: received,
    signature: sign(timestamp, received),
    timestamp: String(timestamp)
  });
  await verify(req);

  // And a signature computed over the re-serialised form must not pass.
  const wrong = fakeRequest({
    body: JSON.parse(received),
    rawBody: received,
    signature: sign(timestamp, reserialised),
    timestamp: String(timestamp)
  });
  await rejectsWith(wrong, 'WEBHOOK_SIGNATURE_INVALID');
});

test('a body edited after signing is rejected', async () => {
  const req = signedRequest({ id: 'x', status: 'SUCCEEDED' }, {
    mutate: raw => raw.replace('SUCCEEDED', 'FAILED')
  });
  await rejectsWith(req, 'WEBHOOK_SIGNATURE_INVALID');
});

test('the timestamp is inside the MAC, so it cannot be moved', async () => {
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
  await rejectsWith(req, 'WEBHOOK_SIGNATURE_INVALID');
});

test('a stale delivery is rejected, and so is one from the future', async () => {
  // Two-sided: a far-future timestamp is as invalid as a stale one, or a clock
  // an attacker controls simply moves the window along with them.
  for (const offset of [-(config.webhookToleranceSeconds + 60), config.webhookToleranceSeconds + 60]) {
    await rejectsWith(
      signedRequest({ id: 'x' }, { timestamp: now() + offset }),
      'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE'
    );
  }
});

test('missing headers are their own error, not a signature mismatch', async () => {
  await rejectsWith(
    fakeRequest({ body: {}, rawBody: '{}', signature: undefined }),
    'WEBHOOK_SIGNATURE_MISSING'
  );
});

test('a replayed signature is refused once the store has seen it', async () => {
  // SET NX returns null when the key already exists, which is the store saying
  // this exact signature has already been handled.
  redis.set = async () => null;
  try {
    await rejectsWith(signedRequest({ id: 'x', status: 'SUCCEEDED' }), 'WEBHOOK_ALREADY_PROCESSED');
  } finally {
    redis.set = async () => 'OK';
  }
});

test('an unavailable replay store fails closed', async () => {
  // Without it there is no exactly-once guarantee on a money-moving callback,
  // and letting the delivery through would be choosing double payment over
  // downtime.
  redis.set = async () => { throw new Error('redis down'); };
  try {
    await rejectsWith(signedRequest({ id: 'x', status: 'SUCCEEDED' }), 'WEBHOOK_REPLAY_PROTECTION_UNAVAILABLE');
  } finally {
    redis.set = async () => 'OK';
  }
});

test('no raw body means nothing can be verified, so nothing is accepted', async () => {
  // Fails closed. If the parser did not capture the bytes there is no honest
  // way to check the signature, and guessing is how a forged delivery gets in.
  const timestamp = now();
  await rejectsWith(
    fakeRequest({
      body: { id: 'x' }, rawBody: undefined, signature: sign(timestamp, '{}'), timestamp: String(timestamp)
    }),
    'WEBHOOK_BODY_UNVERIFIABLE'
  );
});

test('the parser reads only what it can attribute', () => {
  const parsed = PROVIDERS.SPLITE.parse({
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
  const parsed = PROVIDERS.SPLITE.parse({ id: 'x', status: 'under_review' });
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
