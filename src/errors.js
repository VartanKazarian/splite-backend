/**
 * The error contract.
 *
 * Every failure leaves the API as the same object:
 *
 *   { "error": { "code", "message", "details", "requestId" } }
 *
 * `code` is the field clients branch on. `message` is for humans and may be
 * reworded at any time — treating it as an identifier is what this module
 * exists to stop. Before it there were four shapes in production: a bare
 * string, `{ message, requestId }`, an array of validation strings, and a
 * string with `code` and `billId` as *siblings* of `error`. A client could not
 * even destructure the response without knowing which route produced it.
 *
 * `src/middleware/errorHandler.js` is the only place that renders this, and
 * every failure reaches it by throwing or by `next(err)`. One renderer means
 * the envelope cannot drift: a new route gets the shape for free, and there is
 * no second copy to forget to update.
 */

/**
 * Every code the API can return, with the status it always carries.
 *
 * The mapping is one-directional on purpose: a code implies exactly one status,
 * so a client that switches on `code` never has to also check the status to
 * know what happened. `test/errors.test.js` enforces that.
 */
const CODES = {
  // 400 -- the request itself is wrong.
  VALIDATION_FAILED: 400,
  BILL_ID_MISMATCH: 400,
  INVALID_AMOUNT: 400,
  INVALID_MONETARY_VALUE: 400,
  WEBHOOK_BODY_UNVERIFIABLE: 400,

  // 401 -- who the caller is could not be established.
  AUTH_TOKEN_MISSING: 401,
  AUTH_TOKEN_INVALID: 401,
  INVALID_CREDENTIALS: 401,
  GUEST_SESSION_MISSING: 401,
  GUEST_SESSION_INVALID: 401,
  QR_INVALID: 401,
  WEBHOOK_SIGNATURE_MISSING: 401,
  WEBHOOK_SIGNATURE_INVALID: 401,
  WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE: 401,

  // 403 -- the caller is known and still not allowed.
  FORBIDDEN_ROLE: 403,
  CROSS_TENANT_DENIED: 403,
  CORS_ORIGIN_NOT_ALLOWED: 403,

  // 404 -- named per resource, so a client can tell which lookup failed
  // without parsing prose. All of these mean "not found *in your restaurant*";
  // another tenant's row is reported absent rather than forbidden.
  NOT_FOUND: 404,
  BILL_NOT_FOUND: 404,
  TABLE_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  RESTAURANT_NOT_FOUND: 404,
  OPEN_BILL_NOT_FOUND: 404,

  // 409 -- valid request, incompatible with current state.
  OPEN_BILL_EXISTS: 409,
  BILL_NOT_OPEN: 409,
  BILL_HAS_PAYMENTS: 409,
  PAYMENT_EXCEEDS_BALANCE: 409,
  PAYMENT_STATE_INVALID: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_FLIGHT: 409,
  TABLE_NAME_TAKEN: 409,
  PRODUCT_NAME_TAKEN: 409,
  MENU_CURRENCY_MISMATCH: 409,
  WEBHOOK_ALREADY_PROCESSED: 409,

  // 429 / 503 -- try again, and the caller can tell whether it is their fault.
  RATE_LIMITED: 429,
  RATE_LIMITER_UNAVAILABLE: 503,
  FX_UNAVAILABLE: 503,
  WEBHOOK_REPLAY_PROTECTION_UNAVAILABLE: 503,
  SHUTTING_DOWN: 503,

  // 500 -- the message is never echoed; correlate on requestId.
  INTERNAL_ERROR: 500
};

/**
 * What `details` carries, per code.
 *
 * Only codes that carry something appear here; everything else sends `{}`.
 * This is published in the OpenAPI document as `x-error-details` so a client
 * can type the payload rather than discover it by hitting the endpoint, and
 * `test/errors.test.js` fails if a key here is not a real code.
 */
const DETAILS = {
  VALIDATION_FAILED: { fields: 'string[] -- one entry per failed field' },
  OPEN_BILL_EXISTS: { billId: 'uuid -- the bill already open on that table' },
  BILL_NOT_OPEN: { status: 'string -- the status the bill is actually in' },
  PAYMENT_EXCEEDS_BALANCE: { remainingVes: 'string -- minor units still owed' },
  PAYMENT_STATE_INVALID: { from: 'string -- current status', to: 'string -- requested status' },
  MENU_CURRENCY_MISMATCH: { activeProductsInOtherCurrency: 'integer -- how many still disagree' },
  FORBIDDEN_ROLE: { requiredRoles: 'string[] -- roles that would have been accepted' },
  FX_UNAVAILABLE: { currency: 'string -- the currency with no usable rate, when specific to one' },
  RATE_LIMITED: { retryAfterSeconds: 'integer -- matches the Retry-After header' },
  RATE_LIMITER_UNAVAILABLE: { retryAfterSeconds: 'integer -- matches the Retry-After header' }
};

/**
 * An error that is safe to show a caller.
 *
 * Anything thrown that is *not* an ApiError is treated as a bug and rendered as
 * INTERNAL_ERROR with its message withheld, because unexpected messages carry
 * driver, query and file-path detail.
 */
class ApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ApiError';

    if (!(code in CODES)) {
      // A typo'd code would otherwise reach a client as an undefined status and
      // a code nothing can match. Failing here turns that into a test failure.
      throw new Error(`Unknown error code: ${code}`);
    }

    this.code = code;
    this.statusCode = CODES[code];
    this.details = details;
  }
}

/** Sugar for the shape that appears most: throw and let the handler render. */
const apiError = (code, message, details) => new ApiError(code, message, details);

module.exports = { CODES, DETAILS, ApiError, apiError };
