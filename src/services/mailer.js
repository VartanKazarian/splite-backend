const config = require('../config');
const { logger } = require('../connectors/logger');

/**
 * Outbound transactional mail.
 *
 * The project had no way to send an email before this. So it is a port with one
 * method and three adapters rather than a wrapper around a library -- picking
 * the provider is a decision about domains and DKIM records, not about code,
 * and it should be changeable by setting MAIL_TRANSPORT rather than by editing
 * call sites.
 *
 * `resend` is implemented over global fetch rather than an SDK on purpose: it
 * is one POST, and a dependency that ships its own HTTP stack, retry policy and
 * telemetry is a poor trade for that. Adding SES or Postmark means adding a
 * function to TRANSPORTS and nothing else.
 *
 * `smtp` is the exception, and nodemailer earns it. An API sender only accepts
 * a From address on a domain you have signed with DKIM in your own DNS, so a
 * team whose only address is an ordinary mailbox -- a Gmail account with an app
 * password -- cannot use one at all. SMTP is how that mailbox sends, and SMTP
 * is not one POST: it is a stateful dialogue over TLS with AUTH, dot-stuffing,
 * header encoding and connection reuse. Hand-rolling that to avoid a dependency
 * would be trading a well-worn library for a subtly broken transport.
 */

const TRANSPORTS = {
  /**
   * Development only. Writes the message -- including the verification link --
   * to the log, because a link nobody can read is a flow nobody can test.
   *
   * `assertProductionConfig` refuses to start with this transport once
   * onboarding is enabled, which is the whole reason it is safe for it to log
   * the token in full: in production this code path cannot be reached.
   */
  async log(message) {
    logger.info({ event: 'MAIL_LOGGED', to: message.to, subject: message.subject, body: message.text },
      'Mail not sent: MAIL_TRANSPORT=log');
    return { id: null, transport: 'log' };
  },

  async resend(message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.mail.timeoutMs);
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.mail.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          from: config.mail.from,
          to: [message.to],
          subject: message.subject,
          text: message.text
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        // The provider's body can quote the recipient address back, so it is
        // logged rather than propagated: this error reaches a caller who is not
        // authenticated and must learn nothing about who else was mailed.
        const body = await res.text().catch(() => '');
        throw new Error(`Resend responded ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = await res.json().catch(() => ({}));
      return { id: json.id ?? null, transport: 'resend' };
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * An ordinary mailbox, over SMTP.
   *
   * Deliverability is the mailbox provider's, not ours: mail genuinely sent
   * through Gmail's relay carries Gmail's SPF and DKIM, so it is not the
   * forgery a gmail.com From on an API sender would be. What it does not carry
   * is our own domain, and free accounts have a daily send ceiling, so this is
   * the transport for a product that is starting rather than the one it ends
   * on. Moving to a verified domain later is a MAIL_* change, not a code one.
   */
  async smtp(message) {
    const transporter = smtpTransporter();
    const info = await transporter.sendMail({
      from: config.mail.from,
      to: message.to,
      subject: message.subject,
      text: message.text
    });
    return { id: info.messageId ?? null, transport: 'smtp' };
  }
};

/**
 * The SMTP connection, built once and reused.
 *
 * Built lazily rather than at import: a process that never sends mail -- every
 * CLI script in `scripts/`, and the API itself when onboarding is off -- should
 * not open a socket or even load the library. Held afterwards because it is
 * pooled: a TLS handshake plus AUTH per message is both slow and a good way to
 * be rate-limited by the provider.
 */
let transporterMemo = null;

function smtpTransporter() {
  if (transporterMemo) return transporterMemo;
  // Required here, not at the top, so the dependency is only loaded by a
  // process that actually sends.
  const nodemailer = require('nodemailer');
  const { host, port, secure, user, password } = config.mail.smtp;
  transporterMemo = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: password },
    // One reused connection rather than a TLS handshake and an AUTH round trip
    // per message. Capped at one because the volume here is a verification link
    // at a time, and a mailbox provider counts concurrent connections.
    pool: true,
    maxConnections: 1,
    // The same budget the API sender gets, applied to each leg of the dialogue
    // rather than to the whole exchange, so a relay that accepts the connection
    // and then stalls still fails instead of holding the request open.
    connectionTimeout: config.mail.timeoutMs,
    greetingTimeout: config.mail.timeoutMs,
    socketTimeout: config.mail.timeoutMs
  });
  return transporterMemo;
}

/** Drops the pooled connection. For tests, and for a graceful shutdown. */
function closeTransport() {
  if (!transporterMemo) return;
  transporterMemo.close?.();
  transporterMemo = null;
}

/**
 * Sends, and never throws at the caller.
 *
 * A provider outage must not fail the request that triggered the mail. For a
 * signup that matters twice over: the row is already committed, so a thrown
 * 500 would tell the visitor their registration failed while it in fact
 * succeeded -- and resubmitting is then blocked by the rate limiter.
 *
 * The failure is logged with the request id so it can be found and resent; the
 * caller gets `{ sent: false, error }` and decides nothing.
 */
async function send(message) {
  const transport = TRANSPORTS[config.mail.transport];
  if (!transport) {
    logger.error({ event: 'MAIL_TRANSPORT_UNKNOWN', transport: config.mail.transport },
      'Configured MAIL_TRANSPORT does not exist');
    return { sent: false, error: `Unknown MAIL_TRANSPORT: ${config.mail.transport}` };
  }

  try {
    const result = await transport(message);
    logger.info({ event: 'MAIL_SENT', to: message.to, subject: message.subject, ...result }, 'Mail sent');
    return { sent: true, ...result };
  } catch (err) {
    logger.error({ event: 'MAIL_SEND_FAILED', to: message.to, subject: message.subject, err },
      'Mail send failed');
    // The reason rides along for a caller that is a person -- `npm run
    // onboarding -- test-mail` exists to be told "535 Username and Password not
    // accepted" rather than "it did not work". No HTTP route reads this: the
    // onboarding service discards the return value entirely, which is what
    // keeps a provider's body (it can quote the recipient back) away from an
    // unauthenticated response.
    return { sent: false, error: err.message };
  }
}

module.exports = { send, closeTransport, TRANSPORTS };
