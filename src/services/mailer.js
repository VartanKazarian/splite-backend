const config = require('../config');
const { logger } = require('../connectors/logger');

/**
 * Outbound transactional mail.
 *
 * The project had no way to send an email before this: no nodemailer, no SMTP,
 * no provider SDK. So this is a port with one method and two adapters rather
 * than a wrapper around a library -- picking the provider is a decision about
 * domains and DKIM records, not about code, and it should be changeable by
 * setting MAIL_TRANSPORT rather than by editing call sites.
 *
 * `resend` is implemented over global fetch rather than an SDK on purpose: it
 * is one POST, and a dependency that ships its own HTTP stack, retry policy and
 * telemetry is a poor trade for that. Adding SES or Postmark means adding a
 * function to TRANSPORTS and nothing else.
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
  }
};

/**
 * Sends, and never throws at the caller.
 *
 * A provider outage must not fail the request that triggered the mail. For a
 * signup that matters twice over: the row is already committed, so a thrown
 * 500 would tell the visitor their registration failed while it in fact
 * succeeded -- and resubmitting is then blocked by the rate limiter.
 *
 * The failure is logged with the request id so it can be found and resent; the
 * caller gets `{ sent: false }` and decides nothing.
 */
async function send(message) {
  const transport = TRANSPORTS[config.mail.transport];
  if (!transport) {
    logger.error({ event: 'MAIL_TRANSPORT_UNKNOWN', transport: config.mail.transport },
      'Configured MAIL_TRANSPORT does not exist');
    return { sent: false };
  }

  try {
    const result = await transport(message);
    logger.info({ event: 'MAIL_SENT', to: message.to, subject: message.subject, ...result }, 'Mail sent');
    return { sent: true, ...result };
  } catch (err) {
    logger.error({ event: 'MAIL_SEND_FAILED', to: message.to, subject: message.subject, err },
      'Mail send failed');
    return { sent: false };
  }
}

module.exports = { send, TRANSPORTS };
