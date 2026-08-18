const banks = require('./banks');

/**
 * How a diner obtains a C2P clave, bank by bank.
 *
 * Source: Mercantil's official acquirer communication -- the "tipología de C2P
 * por banco" table and its e-commerce best-practices annex. Transcribed here
 * rather than remembered, because the two fields that vary most between banks
 * are the two that break a payment when guessed.
 *
 * This is the one step of the C2P flow Splite does not control. The diner asks
 * *their own* bank for a single-use clave and hands it to us; if they get stuck
 * on that step the payment never happens. So the app must show, the moment a
 * bank is chosen, that bank's exact instruction -- not a generic "ask your bank
 * for a clave" that sends a Banplus customer looking for an SMS short code that
 * does not exist.
 *
 * Two fields decide the *shape* of the flow, not just its text:
 *
 *   ttlMinutes  A clave is single-use and expires. Most banks give six hours,
 *               but Banplus gives five minutes and Caroní an hour -- short
 *               enough that a diner who fetches the clave when they sit down
 *               arrives at the till with a dead one. `claveStrategy` turns this
 *               into "ask now" versus "ask at payment".
 *   amountBound A few banks tie the clave to the amount. If the bill changes
 *               after the clave is issued -- one more coffee -- the clave is
 *               void. These are always "ask at payment", whatever the TTL.
 */

const HOUR = 60;

/**
 * Per bank, keyed by the four-digit code every other module already uses.
 *
 * `ttlMinutes: null` means "until the close of the banking day" (Banco de
 * Venezuela), which is neither a fixed number of minutes nor short -- it is
 * handled explicitly rather than forced into a number.
 */
const CLAVE_GUIDE = Object.freeze({
  '0105': { ttlMinutes: 6 * HOUR, app: true, web: false, sms: '24024', smsText: 'SCP' },
  '0134': { ttlMinutes: 6 * HOUR, app: false, web: true, sms: '2846',
            smsText: 'clave dinamica <TIPO> <numero de identificacion>' },
  '0102': { ttlMinutes: null, ttlNote: 'until the close of the banking day',
            app: true, web: true, sms: '2661-2662', smsText: 'Clave de pago' },
  '0108': { ttlMinutes: 3 * HOUR, app: true, web: false, sms: null },
  '0191': { ttlMinutes: 6 * HOUR, app: false, web: true, sms: null },
  '0114': { ttlMinutes: 6 * HOUR, app: true, web: false, sms: '22741', smsText: 'CLAVEMIPAGO' },
  '0172': { ttlMinutes: 3 * HOUR, app: true, web: false, sms: null },
  '0163': { ttlMinutes: 6 * HOUR, app: true, web: false, sms: '2383',
            smsText: 'COMERCIO <TIPO> <numero de identificacion> <coordenada>' },
  '0115': { ttlMinutes: 3 * HOUR, app: true, web: false, sms: '278',
            smsText: 'CLAVE <TIPO> <numero de identificacion>' },
  '0151': { ttlMinutes: 6 * HOUR, app: true, web: false, sms: null },
  '0104': { ttlMinutes: 6 * HOUR, app: true, web: true, sms: null },
  // Banfanb: two short codes by carrier. Movilnet uses 78900; Digitel and
  // Movistar use 326200. Recorded so the app can show the right one.
  '0177': { ttlMinutes: 6 * HOUR, app: false, web: false, sms: '326200',
            smsAlt: { movilnet: '78900', note: '326200 from Digitel or Movistar; 78900 from Movilnet' },
            smsText: 'CLAVE C2P <TIPO> <numero de identificacion>' },
  '0174': { ttlMinutes: 5, app: true, web: false, sms: null },       // five minutes
  '0138': { ttlMinutes: 6 * HOUR, app: true, web: true, sms: '1470',
            smsText: 'CLAVE <TIPO> <numero de identificacion>' },
  // 100% Banco: the clave carries the amount, so it dies if the bill changes.
  '0156': { ttlMinutes: 6 * HOUR, app: true, web: true, sms: '100102', amountBound: true,
            smsText: 'C2P PAGO <monto> <clave de operaciones especiales>' },
  '0171': { ttlMinutes: 3 * HOUR, app: false, web: false, sms: '228486',
            smsText: 'C2P<TIPO><numero de documento> (all uppercase)' },
  '0157': { ttlMinutes: 6 * HOUR, app: false, web: false, sms: '78910', smsText: 'COBROD2' },
  '0137': { ttlMinutes: 6 * HOUR, app: true, web: true, sms: null },
  '0169': { ttlMinutes: 5 * HOUR, app: true, web: false, sms: '22622', smsText: 'PAGAR' },
  '0168': { ttlMinutes: 6 * HOUR, app: true, web: false, sms: null },
  '0175': { ttlMinutes: 6 * HOUR, app: true, web: false, sms: null },
  '0128': { ttlMinutes: 60, app: true, web: false, sms: null }       // one hour
});

/** At or below this, request the clave at payment time or it expires first. */
const SHORT_TTL_MINUTES = 60;

/**
 * When the diner should fetch the clave.
 *
 *   'anytime'    long TTL -- fetch it while waiting for the bill.
 *   'at_payment' short TTL, or a clave bound to the amount -- fetch it only once
 *                the total is final, or it will be dead (or wrong) by the till.
 */
function claveStrategy(bankCode) {
  const bank = CLAVE_GUIDE[bankCode];
  if (!bank) return null;
  const shortLived = bank.ttlMinutes !== null && bank.ttlMinutes <= SHORT_TTL_MINUTES;
  return {
    when: shortLived || bank.amountBound ? 'at_payment' : 'anytime',
    reason: bank.amountBound
      ? 'This bank ties the clave to the amount: fetch it once the total is final'
      : shortLived
        ? `The clave lasts ${bank.ttlMinutes} minutes: fetch it right before paying`
        : 'The clave lasts hours: it can be fetched while waiting'
  };
}

/** A human label for the TTL, so the client does not re-derive it. */
function ttlLabel(bank) {
  if (bank.ttlMinutes === null) return bank.ttlNote;
  if (bank.ttlMinutes < 60) return `${bank.ttlMinutes} minutes`;
  const hours = bank.ttlMinutes / 60;
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * The instructions to paint on the diner's screen for one bank.
 *
 * Returns only the channels that bank actually offers -- never "send an SMS" to
 * a customer whose bank only supports the app -- with the identity-type and
 * -number substituted into the SMS body where the bank's format takes them.
 * `null` for an unknown code, so a caller can fall back rather than render an
 * empty card.
 */
function claveInstructions(bankCode, { idType = 'V', idNumber = '' } = {}) {
  const bank = CLAVE_GUIDE[bankCode];
  if (!bank) return null;

  const channels = [];
  if (bank.app) {
    channels.push({ channel: 'APP', text: `Open the ${banks.lookup(bankCode)?.name ?? bankCode} app and find its C2P payment-clave option` });
  }
  if (bank.web) {
    channels.push({ channel: 'WEB', text: `Sign in to ${banks.lookup(bankCode)?.name ?? bankCode} online banking and generate a C2P payment clave` });
  }
  if (bank.sms) {
    const body = (bank.smsText || '')
      .replace(/<TIPO>/g, idType)
      .replace(/<numero de identificacion>|<numero de documento>/g, idNumber || 'your ID number');
    channels.push({
      channel: 'SMS',
      shortCode: bank.sms,
      smsBody: body,
      text: `Text ${body} to ${bank.sms}`,
      altShortCode: bank.smsAlt?.movilnet ?? null,
      note: bank.smsAlt?.note ?? null
    });
  }

  return {
    bankCode,
    bankName: banks.lookup(bankCode)?.name ?? null,
    ttlMinutes: bank.ttlMinutes,
    ttlLabel: ttlLabel(bank),
    amountBound: Boolean(bank.amountBound),
    strategy: claveStrategy(bankCode),
    channels
  };
}

/** Every C2P-capable bank, for a picker. Ordered by name, in Spanish collation. */
function supportedC2PBanks() {
  return Object.keys(CLAVE_GUIDE)
    .map(code => ({
      code,
      name: banks.lookup(code)?.name ?? code,
      ttlMinutes: CLAVE_GUIDE[code].ttlMinutes,
      amountBound: Boolean(CLAVE_GUIDE[code].amountBound)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

module.exports = {
  CLAVE_GUIDE, SHORT_TTL_MINUTES,
  claveStrategy, claveInstructions, supportedC2PBanks
};
