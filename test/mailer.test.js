const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const mailer = require('../src/services/mailer');

/**
 * The transports, and the promise `send` makes to its callers.
 *
 * The promise is the part worth testing hardest: `send` never throws. A signup
 * commits its row before the mail goes out, so an exception here would tell a
 * visitor their registration failed when it in fact succeeded -- and the rate
 * limiter would then block them from trying again.
 */

/** Runs `fn` with config.mail temporarily replaced, and always puts it back. */
async function withMailConfig(overrides, fn) {
  const original = config.mail;
  config.mail = { ...original, ...overrides };
  try {
    return await fn();
  } finally {
    config.mail = original;
    mailer.closeTransport();
  }
}

/**
 * Replaces the nodemailer module for the duration of `fn`.
 *
 * The transport requires it lazily, so seeding the module cache is enough --
 * and it has to be restored, or every later test in this process gets the stub.
 */
async function withNodemailer(stub, fn) {
  const id = require.resolve('nodemailer');
  const saved = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: stub };
  try {
    return await fn();
  } finally {
    if (saved) require.cache[id] = saved;
    else delete require.cache[id];
    mailer.closeTransport();
  }
}

test('the log transport reports what it did rather than pretending to send', async () => {
  const result = await withMailConfig({ transport: 'log' }, () =>
    mailer.send({ to: 'a@example.com', subject: 'Hola', text: 'Link' }));

  assert.equal(result.sent, true);
  assert.equal(result.transport, 'log');
});

test('an unknown transport fails the send instead of the request', async () => {
  const result = await withMailConfig({ transport: 'carrier-pigeon' }, () =>
    mailer.send({ to: 'a@example.com', subject: 'Hola', text: 'Link' }));

  assert.equal(result.sent, false);
  assert.match(result.error, /carrier-pigeon/);
});

test('a transport that throws is swallowed and reported as not sent', async () => {
  const original = mailer.TRANSPORTS.log;
  mailer.TRANSPORTS.log = async () => { throw new Error('provider is down'); };
  try {
    const result = await withMailConfig({ transport: 'log' }, () =>
      mailer.send({ to: 'a@example.com', subject: 'Hola', text: 'Link' }));
    assert.equal(result.sent, false);
    // Carried back for `npm run onboarding -- test-mail`, whose entire job is to
    // say which thing is wrong. A caller told only "false" cannot fix anything.
    assert.equal(result.error, 'provider is down');
  } finally {
    mailer.TRANSPORTS.log = original;
  }
});

test('smtp sends the configured From, not the recipient-supplied one', async () => {
  const sent = [];
  const created = [];
  const stub = {
    createTransport(options) {
      created.push(options);
      return {
        async sendMail(message) { sent.push(message); return { messageId: '<abc@gmail.com>' }; },
        close() {}
      };
    }
  };

  const result = await withNodemailer(stub, () => withMailConfig({
    transport: 'smtp',
    from: 'Splite <splite.ve@gmail.com>',
    fromAddress: 'splite.ve@gmail.com',
    timeoutMs: 4000,
    smtp: {
      host: 'smtp.gmail.com', port: 465, secure: true,
      user: 'splite.ve@gmail.com', password: 'app-password'
    }
  }, () => mailer.send({ to: 'dueno@example.com', subject: 'Verifica', text: 'https://x/y' })));

  assert.equal(result.sent, true);
  assert.equal(result.transport, 'smtp');
  assert.equal(result.id, '<abc@gmail.com>');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, 'Splite <splite.ve@gmail.com>');
  assert.equal(sent[0].to, 'dueno@example.com');
  assert.equal(sent[0].subject, 'Verifica');
  assert.equal(sent[0].text, 'https://x/y');

  // Implicit TLS with credentials, and every leg of the dialogue bounded --
  // a relay that accepts a connection and then stalls must not hold a request
  // open indefinitely.
  assert.equal(created.length, 1);
  assert.equal(created[0].host, 'smtp.gmail.com');
  assert.equal(created[0].port, 465);
  assert.equal(created[0].secure, true);
  assert.deepEqual(created[0].auth, { user: 'splite.ve@gmail.com', pass: 'app-password' });
  for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
    assert.equal(created[0][key], 4000, `${key} must be bounded`);
  }
});

test('the smtp connection is built once and reused across sends', async () => {
  // A TLS handshake and an AUTH round trip per message is both slow and a good
  // way to be rate-limited by a mailbox provider.
  let built = 0;
  const stub = {
    createTransport() {
      built += 1;
      return { async sendMail() { return { messageId: '<x@y>' }; }, close() {} };
    }
  };

  await withNodemailer(stub, () => withMailConfig({
    transport: 'smtp',
    from: 'Splite <splite.ve@gmail.com>',
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'u', password: 'p' }
  }, async () => {
    await mailer.send({ to: 'a@example.com', subject: 's', text: 't' });
    await mailer.send({ to: 'b@example.com', subject: 's', text: 't' });
  }));

  assert.equal(built, 1);
});

test('closing the transport releases the socket and lets the next send rebuild', async () => {
  // A pooled connection left open holds the event loop past the last request,
  // which turns a graceful shutdown into a forced one.
  let built = 0;
  let closed = 0;
  const stub = {
    createTransport() {
      built += 1;
      return { async sendMail() { return { messageId: '<x@y>' }; }, close() { closed += 1; } };
    }
  };

  await withNodemailer(stub, () => withMailConfig({
    transport: 'smtp',
    from: 'Splite <splite.ve@gmail.com>',
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'u', password: 'p' }
  }, async () => {
    await mailer.send({ to: 'a@example.com', subject: 's', text: 't' });
    mailer.closeTransport();
    // Asserted here rather than after the helpers unwind: their own teardown
    // closes too, which would make the count say nothing about this call.
    assert.equal(closed, 1, 'closing must reach the transport, not just drop the reference');
    await mailer.send({ to: 'b@example.com', subject: 's', text: 't' });
    assert.equal(built, 2, 'a send after a close must build a new connection');
  }));
});

test('an smtp failure is a failed send, never a thrown request', async () => {
  const stub = {
    createTransport() {
      return {
        async sendMail() { throw new Error('535 Username and Password not accepted'); },
        close() {}
      };
    }
  };

  const result = await withNodemailer(stub, () => withMailConfig({
    transport: 'smtp',
    from: 'Splite <splite.ve@gmail.com>',
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'u', password: 'bad' }
  }, () => mailer.send({ to: 'a@example.com', subject: 's', text: 't' })));

  assert.equal(result.sent, false);
  assert.match(result.error, /535/);
});

test('resend posts the message and treats a rejection as a failed send', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ id: 'resend-1' }) };
  };

  try {
    const result = await withMailConfig({
      transport: 'resend', apiKey: 're_test', from: 'Splite <hola@splite.example>', timeoutMs: 5000
    }, () => mailer.send({ to: 'a@example.com', subject: 'Verifica', text: 'https://x/y' }));

    assert.equal(result.sent, true);
    assert.equal(result.id, 'resend-1');
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].options.headers.authorization, 'Bearer re_test');
    assert.deepEqual(JSON.parse(calls[0].options.body).to, ['a@example.com']);

    // A provider that rejects the sender says so in the body. That body can
    // quote the recipient back, so it must not reach a caller who is not
    // authenticated -- the send simply fails.
    global.fetch = async () => ({
      ok: false, status: 403, text: async () => 'The gmail.com domain is not verified'
    });
    const rejected = await withMailConfig({
      transport: 'resend', apiKey: 're_test', from: 'Splite <splite.ve@gmail.com>', timeoutMs: 5000
    }, () => mailer.send({ to: 'a@example.com', subject: 'Verifica', text: 'https://x/y' }));
    assert.equal(rejected.sent, false);
    assert.match(rejected.error, /403/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('the failure reason never reaches the caller of a submission', async () => {
  // `send` hands the reason back so a human running the CLI is told what broke.
  // The onboarding service must still discard it: a provider's body can quote
  // the recipient address back, and the endpoint that triggers this mail is
  // unauthenticated, so it must learn nothing about who else was mailed.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'onboarding.js'), 'utf8'
  );

  const assigned = [...source.matchAll(/(\w+)\s*=\s*await mailer\.send/g)].map(m => m[1]);
  assert.deepEqual(assigned, [], `onboarding must not read the send result: ${assigned.join(', ')}`);
  assert.match(source, /await mailer\.send\(/, 'the notification must still be sent');
});
