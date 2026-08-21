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
  // The upload is not something the menu reader can open.
  MENU_OCR_UNSUPPORTED_MEDIA: 400,
  MENU_OCR_FILE_REQUIRED: 400,
  // A PDF that pdftoppm cannot rasterise. The remedy is the caller's -- export
  // it again, or photograph the page -- so it is a 400, not a server fault.
  MENU_OCR_PDF_UNREADABLE: 400,
  MENU_OCR_FILE_TOO_LARGE: 400,
  SPLIT_PARTICIPANTS_INVALID: 400,
  SPLIT_CLAIMS_INCOMPLETE: 400,
  SPLIT_CLAIM_UNKNOWN: 400,
  SPLIT_AMOUNT_MISMATCH: 400,

  // 401 -- who the caller is could not be established.
  AUTH_TOKEN_MISSING: 401,
  AUTH_TOKEN_INVALID: 401,
  INVALID_CREDENTIALS: 401,
  MFA_CODE_INVALID: 401,
  GUEST_SESSION_MISSING: 401,
  GUEST_SESSION_INVALID: 401,
  // One code for "no such token", "already used" and "expired" on purpose. A
  // caller holding a verification link has no legitimate use for the
  // difference, and distinguishing them turns the endpoint into an oracle for
  // which links exist.
  ONBOARDING_TOKEN_INVALID: 401,
  QR_INVALID: 401,
  WEBHOOK_SIGNATURE_MISSING: 401,
  WEBHOOK_SIGNATURE_INVALID: 401,
  WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE: 401,

  // 403 -- the caller is known and still not allowed.
  FORBIDDEN_ROLE: 403,
  CROSS_TENANT_DENIED: 403,
  CORS_ORIGIN_NOT_ALLOWED: 403,
  // Staff administration. Three separate codes because they are three separate
  // conversations: you lack the standing, you are pointing at yourself, or the
  // restaurant would be left with nobody able to undo it.
  STAFF_OUTRANKED: 403,
  STAFF_ROLE_TOO_HIGH: 403,
  STAFF_SELF_FORBIDDEN: 403,

  // 404 -- named per resource, so a client can tell which lookup failed
  // without parsing prose. All of these mean "not found *in your restaurant*";
  // another tenant's row is reported absent rather than forbidden.
  NOT_FOUND: 404,
  STAFF_NOT_FOUND: 404,
  BILL_NOT_FOUND: 404,
  BILL_ITEM_NOT_FOUND: 404,
  TABLE_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  RESTAURANT_NOT_FOUND: 404,
  OPEN_BILL_NOT_FOUND: 404,
  PAYMENT_CLAIM_NOT_FOUND: 404,
  SPLIT_NOT_FOUND: 404,
  SPLIT_SHARE_NOT_FOUND: 404,
  // A webhook for a provider this deployment has no adapter for. 404 rather
  // than 400: the path segment names a resource that does not exist here.
  WEBHOOK_PROVIDER_UNKNOWN: 404,

  // 409 -- valid request, incompatible with current state.
  OPEN_BILL_EXISTS: 409,
  STAFF_EMAIL_TAKEN: 409,
  PASSWORD_UNCHANGED: 409,
  STAFF_LAST_OWNER: 409,
  // Enrolment state, all of them "the account is not in the state this asks
  // for" rather than an authentication failure.
  MFA_ALREADY_ENABLED: 409,
  MFA_NOT_ENABLED: 409,
  MFA_NOT_ENROLLED: 409,
  BILL_NOT_OPEN: 409,
  BILL_NOT_ITEMISED: 409,
  TOTAL_BELOW_AMOUNT_PAID: 409,
  PRODUCT_INACTIVE: 409,
  SPLIT_NOT_ITEMISED: 409,
  SPLIT_NOTHING_OUTSTANDING: 409,
  BILL_HAS_PAYMENTS: 409,
  PAYMENT_EXCEEDS_BALANCE: 409,
  PAYMENT_STATE_INVALID: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_FLIGHT: 409,
  TABLE_NAME_TAKEN: 409,
  PRODUCT_NAME_TAKEN: 409,
  MENU_CURRENCY_MISMATCH: 409,
  WEBHOOK_ALREADY_PROCESSED: 409,
  // Raised only when a *verified* signup loses a race to an identical one --
  // never by the public registration endpoint, which must not reveal whether an
  // address or a tax id is already on file. See src/services/onboarding.js.
  EMAIL_ALREADY_REGISTERED: 409,
  RIF_ALREADY_REGISTERED: 409,
  // One bank reference settles one bill. Raised when a second diner declares a
  // reference another claim already holds -- the cheapest attack on a manual
  // confirmation flow is to repeat the number the next table read aloud -- and
  // when resolving an in-doubt C2P charge lands on a bank movement that already
  // settled a different payment. Both are the same rule; the second one is
  // enforced by payments_provider_reference_idx rather than by a person.
  PAYMENT_REFERENCE_ALREADY_USED: 409,
  PAYMENT_CLAIM_NOT_PENDING: 409,
  // A bill already has a live split; agree a new one only after voiding it.
  SPLIT_ALREADY_EXISTS: 409,
  // Voiding or paying against a split that is no longer ACTIVE.
  SPLIT_NOT_ACTIVE: 409,
  // The bill changed after the split was agreed, so the split no longer covers
  // it and takes no further payments. Distinct from SPLIT_NOT_ACTIVE because the
  // remedy is different and worth telling a diner plainly: agree a new split on
  // the new total, rather than "that split was discarded".
  SPLIT_STALE: 409,
  // A split people have started settling against is a record, not a draft.
  SPLIT_HAS_PAYMENTS: 409,
  // The per-share ceiling: a payment that names a share may not exceed what is
  // left on it. The bill-level PAYMENT_EXCEEDS_BALANCE's analogue one level down.
  SPLIT_SHARE_OVERPAID: 409,
  // Sealed credentials that will not authenticate, or were sealed with a key no
  // longer in the ring. Never a missing credential -- a failed tag means a
  // modified one, and the only safe answer to that is to stop.
  PAYMENT_CREDENTIALS_UNREADABLE: 500,
  // A secret we cannot open is our failure, not the caller's.
  MFA_SECRET_UNREADABLE: 500,
  PAYMENT_PROVIDER_UNKNOWN: 404,

  // 429 / 503 -- try again, and the caller can tell whether it is their fault.
  RATE_LIMITED: 429,
  RATE_LIMITER_UNAVAILABLE: 503,
  FX_UNAVAILABLE: 503,
  // A signed delivery we could not tie to a payment. 503 rather than 404
  // because it is usually a race, not a mistake: a provider can call back
  // before the transaction that created our PENDING row has committed, and
  // every provider retries a 5xx. Answering 2xx there loses a real settlement
  // permanently -- the money has moved and the bill never closes.
  WEBHOOK_PAYMENT_UNRESOLVED: 503,
  WEBHOOK_REPLAY_PROTECTION_UNAVAILABLE: 503,
  SHUTTING_DOWN: 503,

  // 503 -- the deployment cannot handle credentials right now. Not 500: this is
  // configuration, and saying so is what stops somebody hunting a bug.
  PAYMENT_CREDENTIALS_KEY_MISSING: 503,
  // The deployment has no MFA key ring, so enrolment is unavailable rather
  // than broken -- the same shape as a payment rail with no credentials.
  MFA_KEY_MISSING: 503,

  // The rail exists but is not usable: no endpoint configured for the
  // deployment, or credentials stored for the restaurant that nobody has proven
  // work. Distinct from PAYMENT_PROVIDER_UNKNOWN (404, no adapter at all)
  // because the remedy is different -- one is a deploy, the other is a form.
  PAYMENT_PROVIDER_MISCONFIGURED: 503,

  // The bank could not be asked. Raised only while resolving an in-doubt
  // charge, and deliberately not fatal: the payment stays IN_DOUBT and the
  // question can be asked again. Answering anything else here would be
  // inventing a settlement outcome from a network error.
  PAYMENT_RESOLUTION_UNAVAILABLE: 503,

  // No vision provider configured for this deployment. Configuration, not a
  // bug, and saying so stops somebody hunting one.
  MENU_OCR_NOT_CONFIGURED: 503,
  // The provider refused, timed out, or answered with something unreadable.
  // Retryable: nothing was written, because this endpoint never writes.
  MENU_OCR_UNAVAILABLE: 503,
  MENU_OCR_UNREADABLE_RESPONSE: 503,

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
  TOTAL_BELOW_AMOUNT_PAID: {
    amountPaidVes: 'string -- minor units already settled',
    proposedTotalVes: 'string -- what the change would have made the total'
  },
  BILL_NOT_ITEMISED: { totalDue: 'string -- the manually supplied total blocking itemisation' },
  SPLIT_PARTICIPANTS_INVALID: { reason: 'string -- which rule the participant list broke' },
  SPLIT_CLAIMS_INCOMPLETE: { unclaimedItemIds: 'string[] -- lines nobody claimed' },
  SPLIT_CLAIM_UNKNOWN: {
    unknownItemIds: 'string[] -- claimed lines not on this bill',
    unknownParticipantIds: 'string[] -- claimants not in the participant list'
  },
  SPLIT_AMOUNT_MISMATCH: {
    outstandingVes: 'string -- what the amounts had to sum to',
    submittedTotalVes: 'string -- what they actually summed to'
  },
  FORBIDDEN_ROLE: { requiredRoles: 'string[] -- roles that would have been accepted' },
  PAYMENT_CLAIM_NOT_PENDING: { status: 'string -- the status the claim is actually in' },
  SPLIT_NOT_ACTIVE: { status: 'string -- the status the split is actually in' },
  SPLIT_STALE: { billTotalVes: 'string -- what the bill now totals, which the split no longer covers' },
  MENU_OCR_UNSUPPORTED_MEDIA: { contentType: 'string -- what was uploaded' },
  MENU_OCR_FILE_TOO_LARGE: { maxBytes: 'integer -- the upload ceiling' },
  MENU_OCR_UNAVAILABLE: { retryAfterSeconds: 'integer -- how long to wait before retrying' },
  SPLIT_SHARE_OVERPAID: { shareRemainingVes: 'string -- minor units still owed on that share' },
  PAYMENT_PROVIDER_MISCONFIGURED: { provider: 'string -- the rail that is configured but not usable' },
  PAYMENT_RESOLUTION_UNAVAILABLE: { retryAfterSeconds: 'integer -- matches the Retry-After header' },
  PAYMENT_REFERENCE_ALREADY_USED: { reference: 'string -- the bank reference already spent, when known' },
  WEBHOOK_PROVIDER_UNKNOWN: { provider: 'string -- the unrecognised provider segment' },
  WEBHOOK_PAYMENT_UNRESOLVED: { retryAfterSeconds: 'integer -- matches the Retry-After header' },
  FX_UNAVAILABLE: { currency: 'string -- the currency with no usable rate, when specific to one' },
  RATE_LIMITED: { retryAfterSeconds: 'integer -- matches the Retry-After header' },
  CORS_ORIGIN_NOT_ALLOWED: { origin: 'string -- the rejected Origin, so it can be copied into CORS_ORIGINS' },
  RATE_LIMITER_UNAVAILABLE: { retryAfterSeconds: 'integer -- matches the Retry-After header' },
  STAFF_OUTRANKED: {
    actorRole: 'string -- your role',
    targetRole: 'string -- theirs, which is at or above it'
  },
  STAFF_ROLE_TOO_HIGH: {
    actorRole: 'string -- your role',
    role: 'string -- the role you tried to grant, which is at or above it'
  },
  STAFF_SELF_FORBIDDEN: { hint: 'string -- who can do this for you instead' },
  STAFF_EMAIL_TAKEN: { email: 'string -- the address, which already belongs to somebody here' },
  STAFF_LAST_OWNER: { hint: 'string -- what has to happen first' }
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
