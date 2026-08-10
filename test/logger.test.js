const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const pino = require('pino');

const { REDACT_PATHS, runWithContext, getContext, addContext, contextSnapshot } = require('../src/connectors/logger');

/** A logger writing to memory, built exactly like the real one. */
function capturingLogger(extra = {}) {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(JSON.parse(chunk.toString())); cb(); }
  });
  const logger = pino({
    level: 'debug',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...extra
  }, stream);
  return { logger, lines, raw: () => JSON.stringify(lines) };
}

test('a bearer token never reaches the output, however it is nested', () => {
  const { logger, raw } = capturingLogger();

  logger.info({ req: { headers: { authorization: 'Bearer supersecret' } } }, 'with headers');
  logger.info({ headers: { authorization: 'Bearer supersecret' } }, 'bare headers');
  logger.info({ accessToken: 'supersecret', refreshToken: 'supersecret' }, 'tokens');
  logger.info({ user: { password: 'supersecret' } }, 'nested password');

  assert.equal(raw().includes('supersecret'), false);
});

test('rawHeaders is redacted, since it cannot be filtered by key', () => {
  // Node's rawHeaders is a flat [name, value, ...] array, so the value sits at
  // a numeric index with nothing identifying it as an Authorization header.
  const { logger, raw } = capturingLogger();

  logger.info({ req: { rawHeaders: ['Authorization', 'Bearer supersecret'] } }, 'raw');
  logger.info({ rawHeaders: ['Authorization', 'Bearer supersecret'] }, 'raw bare');

  assert.equal(raw().includes('supersecret'), false);
});

test('a response object does not leak the request that produced it', () => {
  // res.req.rawHeaders is reachable from the access log and leaked the
  // Authorization header even with a custom `res` serializer in place.
  const { logger, raw } = capturingLogger();

  logger.info({ res: { statusCode: 200, req: { rawHeaders: ['Authorization', 'Bearer supersecret'] } } }, 'access');

  assert.equal(raw().includes('supersecret'), false);
});

test('request context reaches a log line without being passed to it', () => {
  const { logger, lines } = capturingLogger({ mixin: contextSnapshot });

  runWithContext({ requestId: 'req-1' }, () => {
    addContext({ restaurantId: 'rest-1', userId: 'user-1' });
    logger.info({ event: 'PAYMENT_APPLIED' }, 'paid');
  });

  assert.equal(lines[0].requestId, 'req-1');
  assert.equal(lines[0].restaurantId, 'rest-1');
  assert.equal(lines[0].userId, 'user-1');
  assert.equal(lines[0].event, 'PAYMENT_APPLIED');
});

test('one log line cannot contaminate the next', () => {
  // pino merges the caller's fields into whatever mixin returns, so it writes
  // into that object. This exercises the real logger's mixin rather than a
  // locally built one, which would pass no matter how logger.js is configured.
  const { logger, lines } = capturingLogger({ mixin: contextSnapshot });

  runWithContext({ requestId: 'req-1' }, () => {
    logger.warn({ event: 'RATE_LIMIT_BACKEND_UNAVAILABLE', keyPrefix: 'auth' }, 'first');
    logger.info({ event: 'REQUEST_COMPLETED' }, 'second');

    assert.equal(getContext().event, undefined, 'the context itself was not written to');
    assert.equal(getContext().keyPrefix, undefined);
  });

  assert.equal(lines[1].event, 'REQUEST_COMPLETED');
  assert.equal('keyPrefix' in lines[1], false, 'the first line\'s fields did not persist');
});

test('the mixin hands back a copy, not the live context', () => {
  runWithContext({ requestId: 'req-1' }, () => {
    const first = contextSnapshot();
    // Stand in for what pino does to this object.
    first.event = 'SOMETHING';
    first.err = new Error('boom');

    assert.equal(getContext().event, undefined, 'mutating the mixin result must not reach the store');
    assert.equal(contextSnapshot().event, undefined, 'the next line starts clean');
    assert.equal(contextSnapshot().requestId, 'req-1', 'while real context still flows');
  });
});

test('concurrent requests do not share context', async () => {
  const seen = [];
  const observe = () => { seen.push(getContext().requestId); };

  await Promise.all([
    new Promise(resolve => runWithContext({ requestId: 'a' }, async () => {
      await new Promise(r => setTimeout(r, 15));
      observe();
      resolve();
    })),
    new Promise(resolve => runWithContext({ requestId: 'b' }, async () => {
      observe();
      resolve();
    }))
  ]);

  assert.deepEqual(seen.sort(), ['a', 'b'], 'each flow kept its own id across an await');
});

test('logging outside a request works and adds nothing', () => {
  const { logger, lines } = capturingLogger({ mixin: contextSnapshot });

  // Startup, shutdown and scheduled work have no request to belong to.
  logger.info({ event: 'SERVER_STARTED' }, 'listening');

  assert.equal(lines[0].event, 'SERVER_STARTED');
  assert.equal(lines[0].requestId, undefined);
  assert.equal(addContext({ userId: 'x' }), undefined, 'adding context outside a request is a no-op');
});
