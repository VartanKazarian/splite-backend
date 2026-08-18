const config = require('../../../config');
const { logger } = require('../../../connectors/logger');
const { loadCredentials } = require('../../providerConfigs');
const { ApiError } = require('../../../errors');

/**
 * Mercantil Cobro a Persona (C2P).
 *
 * The diner asks their own bank for a single-use clave, hands it to us with
 * their phone and cédula, and we ask Mercantil to pull the money. Splite is the
 * initiator here, which is what makes this rail different from every other one
 * in the codebase: a Pago Móvil claim and a webhook both tell us about money
 * that has already moved, and this one asks for money to move and may not be
 * told what happened.
 *
 * ---------------------------------------------------------------------------
 * WIRE FORMAT IS UNCONFIRMED, in the same sense as the bank-code table in
 * src/payments/banks.js.
 *
 * The field names, the paths and -- most consequentially -- whether amounts
 * cross the wire as decimal bolívares or as céntimos are taken from Mercantil's
 * C2P playground and the shapes their search endpoint returns. They have not
 * been confirmed against a live integration, because we do not have one yet.
 *
 * `CHARGE_PATH` and `SEARCH_PATH` are therefore configuration rather than
 * constants, and `toBankAmount`/`toMinorUnits` are a matched pair with a
 * round-trip test, so correcting the amount convention is one function rather
 * than a hunt. Confirm both before the first real charge: sending céntimos
 * where bolívares are expected is a debit a hundred times too large.
 * ---------------------------------------------------------------------------
 */

/**
 * Statuses that mean "we do not know", as opposed to "no".
 *
 * This distinction is the whole point of the class. Mercantil does not promise
 * that `invoice_number` deduplicates, so a charge whose outcome we never
 * learned must not be reported to the diner as declined -- they would retry,
 * and if the first debit did land they have now paid twice for one dinner.
 *
 *   408  we gave up waiting; the core may still have applied it
 *   425  too early, and the request may be replayed by their edge
 *   429  throttled, possibly *after* the debit was queued
 *   5xx  the core may have applied the debit and lost the response
 *
 * Only a deliberate 4xx rejection -- 400, 401, 403, 404, 409, 422 -- is a
 * decision the bank actually made and is safe to relay as one.
 */
const INDETERMINATE_HTTP = new Set([408, 425, 429]);
const isIndeterminateStatus = status =>
  INDETERMINATE_HTTP.has(status) || (status >= 500 && status <= 599);

/** Internal classification. Never reaches a client; the service maps it. */
class MercantilC2PError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'MercantilC2PError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Strips anything that must never be written down.
 *
 * `clave` is the reason this exists. It is a single-use password the diner
 * obtained from their own bank, it is in the charge body, and a debug log of a
 * failed charge is exactly where it would otherwise end up -- in a file, in a
 * log aggregator, and in the search index of whatever reads that aggregator.
 *
 * Applied to the request body and to the parsed error payload, because banks
 * echo submitted fields back in validation errors.
 */
function redact(value) {
  if (!value || typeof value !== 'object') return value;
  const out = Array.isArray(value) ? [...value] : { ...value };
  for (const key of Object.keys(out)) {
    if (/clave|password|secret|token|authorization|apikey|api_key/i.test(key)) {
      out[key] = '[REDACTED]';
    } else if (out[key] && typeof out[key] === 'object') {
      out[key] = redact(out[key]);
    }
  }
  return out;
}

/**
 * A bank amount, normalised to integer minor units as a string.
 *
 * Mercantil returns decimals -- "126.00", and "1.234,56" from the endpoints
 * that format for es-VE. Feeding either straight to BigInt throws a SyntaxError,
 * and the version of this code that did so did it inside the resolver's
 * `.find()`: a 500 on the only route that can tell a diner whether their money
 * is gone, triggered by the ordinary case rather than an unusual one.
 *
 * Returns null for anything unrecognised so the movement is dropped rather than
 * priced wrongly. `matchInDoubtPayment` treats null as "not evidence".
 */
function toMinorUnits(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;

  // Already minor units.
  if (/^\d+$/.test(text)) return text;

  // "1.234,56" (es-VE) uses dot for thousands and comma for decimals;
  // "1234.56" (en) uses the dot for decimals. The presence of a comma is what
  // tells them apart, so it is read before anything is stripped.
  const normalised = text.includes(',')
    ? text.replace(/\./g, '').replace(',', '.')
    : text;
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;

  const [whole, fraction = ''] = normalised.split('.');
  return String(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}

/**
 * The inverse: minor units to the decimal string a bank body carries.
 *
 * Kept beside `toMinorUnits` and round-tripped in the tests, because these two
 * are the only places the amount convention is expressed. If Mercantil turns
 * out to want céntimos after all, this function becomes `String(minor)` and
 * nothing else changes.
 */
function toBankAmount(minorUnits) {
  const amount = BigInt(String(minorUnits));
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

class MercantilC2PClient {
  /**
   * Credentials are passed in, never read from the environment.
   *
   * They are per restaurant and sealed at rest (migration 018), because each
   * restaurant integrates with its own bank under its own merchant identity.
   * An adapter that read a global `MERCANTIL_API_KEY` would be charging every
   * restaurant through one merchant account, which is both wrong and
   * unbillable. `forRestaurant` below is how one is built.
   */
  constructor({ credentials, baseUrl, chargePath, searchPath, timeoutMs } = {}) {
    const mercantil = config.payments.mercantil;
    this.credentials = credentials ?? null;
    this.baseUrl = baseUrl ?? mercantil.baseUrl;
    this.chargePath = chargePath ?? mercantil.chargePath;
    this.searchPath = searchPath ?? mercantil.searchPath;
    this.timeoutMs = timeoutMs ?? mercantil.timeoutMs;
  }

  /**
   * A client bound to one restaurant's stored credentials.
   *
   * Refuses when the rail is not switched on. `enabled` is only ever set by
   * `markValidated`, which takes the result of a real call to the bank -- so
   * this cannot charge through credentials nobody has proven work.
   */
  static async forRestaurant(restaurantId) {
    const { credentials, enabled } = await loadCredentials({ restaurantId, provider: 'MERCANTIL' });
    if (!enabled) {
      throw new ApiError(
        'PAYMENT_PROVIDER_MISCONFIGURED',
        'Mercantil C2P is not enabled for this restaurant',
        { provider: 'MERCANTIL' }
      );
    }
    return new MercantilC2PClient({ credentials });
  }

  _requireConfigured() {
    const missing = [];
    if (!this.baseUrl) missing.push('MERCANTIL_C2P_URL');
    if (!this.credentials?.clientId) missing.push('clientId');
    if (!this.credentials?.merchantId) missing.push('merchantId');
    if (!this.credentials?.secretKey) missing.push('secretKey');
    if (missing.length) {
      throw new MercantilC2PError(
        'PROVIDER_MISCONFIGURED',
        `Mercantil C2P is not configured: missing ${missing.join(', ')}`
      );
    }
  }

  async _request(path, body) {
    this._requireConfigured();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-IBM-Client-Id': this.credentials.clientId,
          authorization: `Bearer ${this.credentials.secretKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }

      if (!response.ok) {
        const indeterminate = isIndeterminateStatus(response.status);
        throw new MercantilC2PError(
          indeterminate ? 'BANK_INDETERMINATE' : 'BANK_REJECTED',
          indeterminate
            ? 'Mercantil did not return a conclusive response'
            : 'Mercantil rejected the operation',
          { httpStatus: response.status, detail: redact(data) }
        );
      }
      return data;
    } catch (err) {
      // Every diagnostic about a C2P call goes through redact(). The body
      // carries the diner's single-use clave, and this is the one place in the
      // codebase where it is in a variable next to a log call.
      if (config.payments.mercantil.debug) {
        logger.warn(
          { event: 'MERCANTIL_C2P_CALL_FAILED', path, code: err.code ?? err.name, body: redact(body) },
          'Mercantil C2P call failed'
        );
      }

      // A timeout is the canonical indeterminate outcome: we stopped listening,
      // the bank did not necessarily stop working.
      if (err.name === 'AbortError') {
        throw new MercantilC2PError('BANK_INDETERMINATE', 'Timed out waiting for Mercantil');
      }
      if (err instanceof MercantilC2PError) throw err;

      // A DNS failure, a refused connection, a TLS error. We never reached
      // them, but we cannot prove we never reached them, so it is indeterminate
      // for the same reason a timeout is.
      throw new MercantilC2PError('BANK_INDETERMINATE', 'Could not obtain a response from Mercantil');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask the bank to debit the diner.
   *
   * @returns {{status: 'SUCCEEDED'|'FAILED', providerPaymentId?, bankReference?, reason?}}
   * @throws  {MercantilC2PError} BANK_INDETERMINATE when the outcome is unknown
   */
  async charge({ invoiceNumber, amountVesMinor, payer }) {
    if (!invoiceNumber) {
      throw new MercantilC2PError('INVALID_INVOICE', 'invoiceNumber is required');
    }
    const amount = BigInt(String(amountVesMinor));
    if (amount <= 0n) {
      throw new MercantilC2PError('INVALID_AMOUNT', 'Charge amount must be positive');
    }
    if (!payer?.bankCode || !payer?.idNumber || !payer?.phone || !payer?.clave) {
      throw new MercantilC2PError('INVALID_PAYER', 'Missing required C2P payer fields');
    }

    return mapCharge(await this._request(this.chargePath, {
      merchant_identify: {
        integratorId: this.credentials.integratorId,
        merchantId: this.credentials.merchantId,
        terminalId: this.credentials.terminalId
      },
      transaction_c2p: {
        invoice_number: invoiceNumber,
        amount: toBankAmount(amount),
        origin_mobile_number: payer.phone,
        destination_bank_id: payer.bankCode,
        destination_id: payer.idNumber,
        payment_reference: payer.clave
      }
    }));
  }

  /**
   * The bank's movements for a window, used to resolve an in-doubt charge.
   *
   * Amount is passed as a server-side filter where the API supports one, but
   * the result is never trusted to be *only* matching movements -- everything
   * is re-checked in `matchInDoubtPayment`, which is where the rule that
   * decides whether money moves belongs.
   */
  async search({ fromDate, toDate, amountVesMinor, phone = null }) {
    const data = await this._request(this.searchPath, {
      merchant_identify: {
        integratorId: this.credentials.integratorId,
        merchantId: this.credentials.merchantId,
        terminalId: this.credentials.terminalId
      },
      search_c2p: {
        from_date: fromDate,
        to_date: toDate,
        amount: toBankAmount(amountVesMinor),
        ...(phone ? { origin_mobile_number: phone } : {})
      }
    });

    const rows = data.movimientos ?? data.transactions ?? data.payments ?? data.transaction_list ?? [];
    const movements = [];
    let dropped = 0;

    for (const row of rows) {
      const movement = {
        reference: String(row.referencia ?? row.reference ?? row.payment_reference ?? ''),
        amountMinor: toMinorUnits(row.amountMinor ?? row.montoMinor ?? row.monto ?? row.amount),
        phoneOrigin: String(row.telefono_origen ?? row.phoneOrigin ?? row.origin_mobile_number ?? row.phone ?? ''),
        bankOrigin: String(row.banco_origen ?? row.bankOrigin ?? row.destination_bank_id ?? ''),
        date: row.fecha ?? row.date ?? null,
        status: String(row.estado ?? row.status ?? '')
      };
      // A movement we cannot identify or cannot price is not evidence. Counted
      // rather than logged one by one, so a change in their response shape
      // shows up as a number instead of a flood.
      if (movement.reference && movement.amountMinor != null) movements.push(movement);
      else dropped++;
    }

    if (dropped) {
      logger.warn(
        { event: 'MERCANTIL_C2P_MOVEMENT_UNREADABLE', dropped, returned: rows.length },
        'Mercantil returned movements in an unrecognised shape'
      );
    }
    return movements;
  }
}

/**
 * Read the bank's verdict, and refuse to invent one.
 *
 * A body that says neither yes nor no is indeterminate, not a failure. This is
 * the second half of the same rule as `isIndeterminateStatus`: the only two
 * things that may be relayed to a diner as final are an explicit approval and
 * an explicit rejection.
 */
function mapCharge(data) {
  const status = String(data.status ?? data.estado ?? data.transaction_c2p_response?.status ?? '').toUpperCase();
  const body = data.transaction_c2p_response ?? data;

  const approved = ['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'APPROVED', 'APROBADO', '00'].includes(status)
    || body.approved === true || body.exitoso === true;
  const rejected = ['FAILED', 'REJECTED', 'DECLINED', 'RECHAZADO'].includes(status)
    || body.approved === false;

  if (approved) {
    return {
      status: 'SUCCEEDED',
      providerPaymentId: String(body.payment_id ?? body.transaction_id ?? body.id ?? '') || null,
      bankReference: String(body.reference ?? body.referencia ?? body.payment_reference ?? '') || null,
      rawStatus: status
    };
  }
  if (rejected) {
    return {
      status: 'FAILED',
      reason: String(body.message ?? body.mensaje ?? 'Mercantil rejected the payment'),
      rawStatus: status
    };
  }

  throw new MercantilC2PError('BANK_INDETERMINATE', 'Mercantil returned an inconclusive status');
}

module.exports = {
  MercantilC2PClient,
  MercantilC2PError,
  isIndeterminateStatus,
  toMinorUnits,
  toBankAmount,
  redact,
  mapCharge
};
