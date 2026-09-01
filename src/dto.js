const { usdReference } = require('./services/split');
const banks = require('./payments/banks');

/**
 * The boundary between the database and the wire.
 *
 * PostgreSQL columns are snake_case; the public API is camelCase. Nothing else
 * in the app is allowed to decide that, because when it was decided per-route
 * the API ended up speaking three conventions at once: `bills` returned raw
 * rows, `menu` aliased some columns in SQL and left `created_at` alone, and
 * payments hand-built camelCase objects. A single `Bill` could carry
 * `total_due_ves` and `usdReference` side by side.
 *
 * These mappers are deliberately written out field by field rather than run
 * through a generic snake-to-camel transform. Two reasons:
 *
 *  1. A generic transform makes the wire contract a *derived function of column
 *     names*, so renaming a column silently renames a public field — exactly the
 *     coupling this boundary exists to break.
 *  2. It leaks by default. `{ ...row }` publishes whatever the SELECT happened
 *     to fetch; an allowlist publishes what was intended. `qr_nonce` and
 *     `password_hash` live one careless `SELECT *` away.
 */

/**
 * A DATE column as a plain ISO date.
 *
 * node-pg parses DATE into a JS Date at *local* midnight, so the default
 * serialisation is a full timestamp: "2025-03-06T04:00:00.000Z" on a Caracas
 * server, "2025-03-06T00:00:00.000Z" on a UTC one — one row, two strings,
 * depending on where the process happens to run. A client that then formats it
 * in its own zone can land a day early, and for a BCV value date that is the
 * difference between one published rate and the next.
 */
function isoDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    // Read back the same local components pg used to build it. Going through
    // toISOString() here would reintroduce the offset this exists to remove.
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

/** A TIMESTAMPTZ column as an ISO 8601 instant. */
function isoTimestamp(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * A bill, with its derived figures.
 *
 * The outstanding balance is computed rather than stored: two maintained
 * counters for one quantity is the drift the payment ledger exists to remove.
 */
function bill(row) {
  const remainingVes = (BigInt(row.total_due_ves) - BigInt(row.amount_paid_ves)).toString();
  const rate = row.fx_rate_ves_per_unit ?? null;

  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    tableId: row.table_id,
    status: row.status,
    // Who this bill is attributed to for tips. Null for bills that predate the
    // column, and for ones a manager has deliberately detached.
    servedBy: row.served_by ?? null,
    // What the menu quoted, kept for display.
    currency: row.currency,
    // The breakdown behind the total. A bill that shows only a grand total is
    // not one a diner can check, and IVA has to be visible on a Venezuelan
    // receipt. Rates ride along as basis points so a client can label the line
    // ("IVA 16%") without hardcoding the number.
    subtotalMinor: row.subtotal_minor,
    vatBps: row.vat_bps,
    vatMinor: row.vat_minor,
    serviceChargeBps: row.service_charge_bps,
    serviceChargeMinor: row.service_charge_minor,
    totalDue: row.total_due,
    // What Splite settles, always VES céntimos.
    totalDueVes: row.total_due_ves,
    amountPaidVes: row.amount_paid_ves,
    remainingVes,
    fxRateVesPerUnit: rate,
    fxRateSource: row.fx_rate_source ?? null,
    fxValueDate: isoDate(row.fx_value_date),
    calculationVersion: row.calculation_version,
    usdReference: {
      totalDue: usdReference(row.total_due_ves, rate),
      amountPaid: usdReference(row.amount_paid_ves, rate),
      remaining: usdReference(remainingVes, rate)
    },
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * A bill line.
 *
 * Amounts are minor units as digit strings, like every other monetary value on
 * the wire -- a decimal string here would be a second money format for clients
 * to handle, and the point of the contract is that there is one.
 *
 * `productId` is nullable by design: the line survives the product it came
 * from, and `name` is the snapshot taken when it was added, not today's menu.
 */
function billItem(row) {
  return {
    id: row.id,
    billId: row.bill_id,
    productId: row.product_id ?? null,
    name: row.name_snapshot,
    unitPriceMinor: row.unit_price_minor,
    currency: row.currency,
    quantity: row.quantity,
    subtotalMinor: row.subtotal_minor,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * A bill with its lines.
 *
 * Kept separate from `bill` rather than making `items` conditional: a field
 * that is sometimes present is exactly the ambiguity the contract work removed.
 * List endpoints return `bill`, single-bill reads return this, and the two are
 * documented as different schemas.
 */
function billWithItems(row, items = []) {
  return {
    ...bill(row),
    itemCount: items.length,
    items: items.map(billItem)
  };
}

/**
 * A bill as a diner sees it.
 *
 * Deliberately narrower than `billWithItems`. A guest holds a bearer token that
 * was handed out by scanning a sticker on a table, so this is the least
 * trusted surface in the API, and it publishes what somebody about to pay
 * actually needs: what was ordered, what is owed, what has been settled.
 *
 * Left out on purpose: `restaurantId` and `calculationVersion` are internal
 * identifiers a diner has no use for, and `fxRateSource` / `fxValueDate` are
 * provenance for staff. The rate itself stays, because the client needs it to
 * show an approximate figure in the currency the menu quoted.
 */
function guestBill(row, items = []) {
  const remainingVes = (BigInt(row.total_due_ves) - BigInt(row.amount_paid_ves)).toString();
  const rate = row.fx_rate_ves_per_unit ?? null;

  return {
    id: row.id,
    tableId: row.table_id,
    status: row.status,
    currency: row.currency,
    // The breakdown behind the total. A bill that shows only a grand total is
    // not one a diner can check, and IVA has to be visible on a Venezuelan
    // receipt. Rates ride along as basis points so a client can label the line
    // ("IVA 16%") without hardcoding the number.
    subtotalMinor: row.subtotal_minor,
    vatBps: row.vat_bps,
    vatMinor: row.vat_minor,
    serviceChargeBps: row.service_charge_bps,
    serviceChargeMinor: row.service_charge_minor,
    totalDue: row.total_due,
    totalDueVes: row.total_due_ves,
    amountPaidVes: row.amount_paid_ves,
    remainingVes,
    fxRateVesPerUnit: rate,
    usdReference: {
      totalDue: usdReference(row.total_due_ves, rate),
      amountPaid: usdReference(row.amount_paid_ves, rate),
      remaining: usdReference(remainingVes, rate)
    },
    itemCount: items.length,
    items: items.map(billItem),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * A declared payment, as staff and the diner both see it.
 *
 * `declaredReference` is published deliberately: the person verifying needs to
 * read it off the screen and find it in the bank app, and the diner needs to
 * see that what arrived is what they typed. It is not a secret -- it is a
 * number the payer already has and the restaurant is about to look up.
 *
 * What is not published is the raw metadata blob. `phoneOrigin` is a diner's
 * personal number and `idOrigin` is their identity document; both go only to
 * staff, through `staffPaymentClaim`.
 */
function paymentClaim(row) {
  return {
    id: row.id,
    billId: row.bill_id,
    amountVes: row.amount_ves,
    // What the payer added on top. Kept beside the amount rather than folded
    // into it: staff verify `amountVes + tipVes` as one figure against the bank
    // app, but only `amountVes` settles the bill.
    tipVes: row.tip_ves ?? '0',
    totalPaidVes: (BigInt(row.amount_ves) + BigInt(row.tip_ves ?? 0)).toString(),
    status: row.status,
    paymentMethod: row.payment_method,
    declaredReference: row.declared_reference ?? null,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * The same claim, with the corroborating detail a verifier needs.
 *
 * Split from `paymentClaim` rather than made conditional: a field that is
 * sometimes present is the ambiguity the DTO boundary exists to remove, and the
 * fields in question are somebody's phone number and identity document.
 *
 * `bankOriginName` is resolved here rather than left to the client, and it is
 * null for anything that is not a code we know. Claims declared before the
 * field was a code carry free text like "Banesco": that is shown as it was
 * given rather than dropped, because a verifier reading last week's queue is
 * better served by an imperfect answer than by a blank.
 */
function staffPaymentClaim(row) {
  const metadata = row.metadata || {};
  const bankOrigin = metadata.bankOrigin ?? null;
  return {
    ...paymentClaim(row),
    phoneOrigin: metadata.phoneOrigin ?? null,
    bankOrigin,
    bankOriginName: banks.lookup(bankOrigin)?.name ?? null,
    idOrigin: metadata.idOrigin ?? null,
    declaredAt: metadata.declaredAt ?? null
  };
}

function table(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    name: row.name,
    active: row.active,
    createdAt: isoTimestamp(row.created_at)
  };
}

/**
 * A table on the floor, with whatever bill is open on it.
 *
 * `openBill` is null when the table is free, never absent, so a client can read
 * `table.openBill?.remainingVes` without first checking which shape it got.
 * The bill here is a summary: enough to render a floor plan and decide what to
 * open, not the full bill with its lines.
 */
function floorTable(row) {
  const rate = row.fx_rate_ves_per_unit ?? null;
  const openBill = row.bill_id
    ? {
      id: row.bill_id,
      status: row.bill_status,
      currency: row.currency,
      subtotalMinor: row.subtotal_minor,
      vatBps: row.vat_bps,
      vatMinor: row.vat_minor,
      serviceChargeBps: row.service_charge_bps,
      serviceChargeMinor: row.service_charge_minor,
      totalDue: row.total_due,
      totalDueVes: row.total_due_ves,
      amountPaidVes: row.amount_paid_ves,
      remainingVes: (BigInt(row.total_due_ves) - BigInt(row.amount_paid_ves)).toString(),
      fxRateVesPerUnit: rate,
      usdReference: usdReference(
        (BigInt(row.total_due_ves) - BigInt(row.amount_paid_ves)).toString(), rate
      ),
      itemCount: row.item_count ?? 0,
      // How long this table has been sitting. A number a manager reads as
      // "they are ready for the bill" or "something has gone wrong", and one
      // the client should not compute -- a browser doing it uses the visitor's
      // clock, which is how a table reads as opened in the future.
      openedAt: isoTimestamp(row.bill_opened_at),
      openMinutes: row.bill_opened_at
        ? Math.max(0, Math.floor((Date.now() - new Date(row.bill_opened_at).getTime()) / 60000))
        : null,
      // Diners at this table who say they have paid and nobody has verified.
      pendingClaims: row.pending_claims ?? 0,
      tipVes: row.tip_ves ?? '0',
      updatedAt: isoTimestamp(row.bill_updated_at)
    }
    : null;

  return { ...table(row), openBill };
}

/**
 * A menu section.
 *
 * `position` travels because it is what the order means: a client that sorts
 * these itself has to be told how, and one that renders them in whatever order
 * they arrived would put desserts before starters the first time a query plan
 * changed.
 */
/**
 * What a scanned table code resolves to, before any session exists.
 *
 * Deliberately thin. This is unauthenticated and reachable by anyone who can
 * photograph a code stuck to a table, so it carries what a landing page needs
 * to orient a diner -- which restaurant, which table, and whether there is a
 * bill to ask for -- and nothing about the money. `restaurantId` is here
 * because the public menu is addressed by it; without that, the menu half of
 * the flow cannot be reached without taking a session first.
 */
function qrContext(row, { hasOpenBill }) {
  return {
    restaurant: {
      id: row.restaurant_id,
      name: row.restaurant_name,
      menuCurrency: row.menu_currency
    },
    table: {
      id: row.id,
      name: row.name
    },
    // Whether to offer the bill at all. Says only what somebody standing in the
    // room can already see; the amount stays behind the session.
    hasOpenBill
  };
}

/**
 * The uploaded menu file, described rather than sent.
 *
 * No bytes: every caller of this either lists the file or decides whether to
 * fetch it, and a DTO that could accidentally serialise a 20 MB buffer into a
 * JSON body is a DTO that eventually will. The file itself has its own route.
 *
 * `url` is the public path, so a client does not assemble it from the id and
 * get it subtly wrong.
 */
function menuDocument(row) {
  return {
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    updatedAt: row.updated_at,
    url: `/api/v1/menu/public/${row.restaurant_id}/pdf`
  };
}

function menuCategory(row) {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    active: row.active,
    // Present only where the query counted; a listing that did not join
    // products omits it rather than reporting zero.
    productCount: row.product_count === undefined ? undefined : Number(row.product_count)
  };
}

function product(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    priceMinorUnits: row.price_minor_units,
    currency: row.currency,
    // The section, flattened onto the product so a client can group without a
    // second request. Null is uncategorised -- a real state, not an absent one.
    categoryId: row.category_id ?? null,
    categoryName: row.category_name ?? null,
    position: row.position ?? 0,
    active: row.active,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * The public menu's narrower product.
 *
 * A guest scanning a QR is shown what a thing is and what it costs. Whether it
 * is active is implied — inactive products are not listed — and when it was
 * last edited is operational detail that no diner needs.
 */
function publicProduct(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    priceMinorUnits: row.price_minor_units,
    currency: row.currency,
    // A diner needs the sections most of all: the alternative is scrolling one
    // alphabetical list to find a drink, which is worse than the paper menu
    // they are sitting next to.
    categoryId: row.category_id ?? null,
    categoryName: row.category_name ?? null
  };
}

/** The restaurant's charge configuration, as basis points. */
function menuCharges(row) {
  return {
    id: row.id,
    name: row.name,
    menuCurrency: row.menu_currency,
    vatBps: row.vat_bps,
    serviceChargeBps: row.service_charge_bps
  };
}

/**
 * The restaurant's own record, including what it is paying for.
 *
 * `trialDaysRemaining` is computed here rather than left to the client: a
 * browser subtracting dates does it in the visitor's timezone with the
 * visitor's clock, which is how a trial reads as expired a day early for
 * somebody whose laptop is set wrong. The server owns the arithmetic and the
 * client renders the number.
 *
 * Negative is meaningful and is not clamped -- "expired 3 days ago" is a
 * different message from "expires today", and flattening both to 0 would make
 * them indistinguishable.
 */
/**
 * Where the restaurant is paid, as staff configure it.
 *
 * The account number is here and deliberately not in `guestPayee` below.
 */
function payout(row) {
  if (!row.payout_bank_code) return null;
  const bank = banks.lookup(row.payout_bank_code);
  return {
    bankCode: row.payout_bank_code,
    bankName: bank?.name ?? null,
    // Whether a payment can actually be raised through this bank, as opposed to
    // the diner being told where to send one by hand. Nothing has a module yet.
    chargeable: banks.hasIntegration(row.payout_bank_code),
    accountNumber: row.payout_account_number,
    phone: row.payout_phone,
    holderId: row.payout_holder_id
  };
}

/**
 * The same details, as a diner needs them.
 *
 * A Pago Móvil is addressed by bank, phone and identity document. It does not
 * need the account number, so the account number is not sent -- publishing a
 * restaurant's account to anyone who scans a sticker on a table should be a
 * decision somebody makes, not a side effect of reusing a mapper.
 */
function guestPayee(row) {
  if (!row.payout_bank_code) return null;
  return {
    bankCode: row.payout_bank_code,
    bankName: banks.lookup(row.payout_bank_code)?.name ?? null,
    phone: row.payout_phone,
    holderId: row.payout_holder_id
  };
}

/**
 * A stored bank credential set, as anything outside the adapter may see it.
 *
 * There is no field here that could carry a secret, and that is the design
 * rather than an omission: `configured` is a boolean because the alternative --
 * a masked or truncated value, "sk_live_••••4821" -- is a leak with a
 * decoration on it, and the four characters shown are the four an attacker
 * needed to confirm a guess.
 */
function paymentProviderConfig(row) {
  return {
    provider: row.provider,
    configured: true,
    enabled: row.enabled,
    // Whether the credentials have been proven against the bank. A rail cannot
    // be switched on until they have -- see migration 018.
    credentialsValidatedAt: isoTimestamp(row.credentials_validated_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

function account(row) {
  const trialEndsAt = row.trial_ends_at ? new Date(row.trial_ends_at) : null;
  const msPerDay = 24 * 60 * 60 * 1000;

  return {
    id: row.id,
    name: row.name,
    rif: row.rif ?? null,
    menuCurrency: row.menu_currency,
    vatBps: row.vat_bps,
    serviceChargeBps: row.service_charge_bps,
    payout: payout(row),
    plan: {
      tier: row.plan_tier,
      trialEndsAt: isoTimestamp(row.trial_ends_at),
      trialDaysRemaining: trialEndsAt
        ? Math.ceil((trialEndsAt.getTime() - Date.now()) / msPerDay)
        : null
    },
    createdAt: isoTimestamp(row.created_at)
  };
}

function menuSettings(row) {
  return {
    id: row.id,
    name: row.name,
    menuCurrency: row.menu_currency
  };
}

/**
 * A C2P charge that has not reached a settled state.
 *
 * The queue that AMBIGUOUS implies. Without it a charge that correctly refused
 * to guess is indistinguishable from one that was simply lost, and the honest
 * answer stops looking like the safe one.
 *
 * `payerPhoneLast4` is four digits and stays four digits. It goes to staff, who
 * need it to tell two simultaneous payers apart in the bank app, and it is not
 * a phone number.
 */
function c2pCharge(row) {
  return {
    paymentId: row.id,
    billId: row.bill_id,
    amountVes: row.amount_ves,
    status: row.status,
    invoiceNumber: row.invoice_number,
    payerBankCode: row.payer_bank_code,
    payerBankName: banks.lookup(row.payer_bank_code)?.name ?? null,
    payerPhoneLast4: row.payer_phone_last4,
    // Every movement that matched on amount, including the ones rejected for
    // not identifying the payer. This is the list to hand a restaurant that
    // insists the money is there.
    candidateReferences: row.candidate_refs ?? [],
    lastReason: row.last_reason ?? null,
    lastResolutionAt: isoTimestamp(row.last_resolution_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * A persistent split, as staff and diners read it.
 *
 * Presentation only: the numbers are computed and frozen by the engine and the
 * database. `remainingVes` and `settled` per participant are derived here so a
 * client renders "who still owes what" without arithmetic of its own -- the
 * same principle the split engine follows.
 *
 * Takes the shape services/splits.js returns: { split, participants, claims, fxRate }.
 */
function billSplit({ split, participants, claims = [], fxRate = null }) {
  return {
    id: split.id,
    billId: split.bill_id,
    mode: split.mode,
    status: split.status,
    currency: 'VES',
    basisVes: String(split.basis_ves),
    createdByType: split.created_by_type,
    participants: participants.map(row => {
      const amount = BigInt(row.amount_ves);
      const paid = BigInt(row.amount_paid_ves);
      const remaining = amount - paid;
      return {
        id: row.id,
        ref: row.ext_ref,
        name: row.name ?? null,
        amountVes: amount.toString(),
        amountPaidVes: paid.toString(),
        remainingVes: remaining.toString(),
        settled: remaining === 0n,
        usdReference: usdReference(amount.toString(), fxRate)
      };
    }),
    // ITEMS only. Which persisted participant claimed which line.
    claims: claims.map(c => ({ billItemId: c.bill_item_id, participantId: c.participant_id })),
    createdAt: isoTimestamp(split.created_at),
    updatedAt: isoTimestamp(split.updated_at)
  };
}

/**
 * A member of staff, as an administrator sees them.
 *
 * `password_hash` is not omitted here so much as never selected -- `staff.js`
 * lists the columns it reads, and the hash is not among them. This mapper is
 * the second wall rather than the first, because a DTO that is the only thing
 * standing between a hash and a response is one refactor from being bypassed.
 *
 * The same field names as `user` in a login response, so a client that already
 * has that type does not need a second one.
 */
function staffMember(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active,
    restaurantId: row.restaurant_id,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

module.exports = {
  isoDate, isoTimestamp, staffMember,
  bill, billItem, billWithItems, guestBill,
  table, floorTable, product, publicProduct, menuCategory, menuDocument, qrContext, menuSettings, menuCharges, account, payout, guestPayee, paymentProviderConfig, paymentClaim, staffPaymentClaim, c2pCharge, billSplit
};
