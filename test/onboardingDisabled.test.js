const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

/**
 * What a deployment with registration switched off tells a client.
 *
 * This exists because of a real message on a real screen. The form answered a
 * bare 404, which is the same answer a mistyped path gets, so the frontend had
 * nothing truthful to render and invented something: "el registro todavía no
 * está habilitado, escríbenos a onboarding@splite.app" -- an address that does
 * not exist, shown to a restaurant that had just typed its details in.
 *
 * A client cannot render an honest message from an ambiguous code, so the code
 * is no longer ambiguous. Every other gated capability in this API says which
 * one it is; this is that, for onboarding.
 *
 * Deliberately a unit test rather than an integration one: the property is
 * about a deployment where the feature is *off*, and the integration suite sets
 * ONBOARDING_ENABLED=true at import before anything else loads.
 */
// Booting the app touches the rate limiter, which reaches for Redis and keeps
// retrying in the background. Without this the file passes and then hangs.
after(async () => {
  const { closeRedis } = require('../src/connectors/redis');
  const db = require('../src/connectors/base');
  await Promise.allSettled([closeRedis(), db.close()]);
});

function request(app, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = JSON.stringify(body ?? {});
      const req = http.request({
        port: server.address().port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      }, res => {
        let out = '';
        res.on('data', chunk => { out += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(out) });
        });
      });
      req.on('error', err => { server.close(); reject(err); });
      req.end(payload);
    });
  });
}

test('a deployment with registration off says so, distinguishably', async () => {
  assert.equal(process.env.ONBOARDING_ENABLED, undefined,
    'this file asserts the disabled path and must not run with the flag set');

  const app = require('../src/app');
  const { status, body } = await request(app, '/api/v1/onboarding/restaurants', {
    restaurantName: 'Caracas test',
    rif: 'J-12345678-9',
    email: 'dueno@example.com',
    phone: '58123456486'
  });

  // 503, not 404: this is configuration, and saying so is what stops a client
  // guessing and a person hunting a bug that is not there.
  assert.equal(status, 503);
  assert.equal(body.error.code, 'ONBOARDING_NOT_CONFIGURED');
  assert.ok(body.error.requestId, 'the envelope still carries a request id');
});

test('a genuinely unknown path is still an ordinary 404', async () => {
  // The point of the code above is that it is *different* from a typo. If both
  // answered the same thing the client would be back to guessing.
  const app = require('../src/app');
  const { status, body } = await request(app, '/api/v1/onboarding-typo/restaurants', {});

  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('the disabled stub reaches no router, so nothing is created and no mail is sent', async () => {
  // The router carries the two fail-closed rate limiters and the only public
  // write surface that creates tenants. Off must mean off: the replacement is a
  // leaf that reads nothing and throws.
  const mailer = require('../src/services/mailer');
  const original = mailer.send;
  let sends = 0;
  mailer.send = async () => { sends += 1; return { sent: true }; };

  try {
    const app = require('../src/app');
    const { status } = await request(app, '/api/v1/onboarding/verify', { token: 'x', password: 'y' });
    assert.equal(status, 503);
    assert.equal(sends, 0, 'a disabled deployment must not send mail');
  } finally {
    mailer.send = original;
  }
});
