# Splite frontend — integration brief

Paste this into Lovable (or hand it to any frontend developer) before building.
It exists because the API has firm conventions, and a client that invents its
own will be subtly wrong about money.

The machine-readable contract is **`openapi.json`** at the repository root. Feed
it to the generator rather than hand-writing types:

```bash
npx openapi-typescript openapi.json -o src/api.d.ts
```

CI fails if that file drifts from the code, so it is always current.

---

## Rule 1: never do arithmetic on money

**Every monetary value is a string of digits in minor units (céntimos).** Not a
number. Not a decimal.

```json
{ "totalDueVes": "1893852", "subtotalMinor": "10000", "vatMinor": "1600" }
```

Two reasons, both real:

- Venezuelan bills run to millions of céntimos. Past `2^53` a JavaScript number
  silently loses precision, and `JSON.parse` has already done the damage before
  your code sees it.
- Below that, floats still produce artifacts — `0.1 + 0.2` money bugs, but in a
  currency where a rounding error is a bill that can never be paid off.

**Prohibited, everywhere:**

```js
Number(bill.totalDueVes)        // ✗
parseFloat(item.unitPriceMinor) // ✗
total / participants.length     // ✗
subtotal * 1.16                 // ✗
```

**You never need to.** The backend computes every total, every tax line and
every split. The only thing the client does with money is **format it for
display**, and that is pure string manipulation:

```ts
/** "1893852" -> "18.938,52"  (Venezuelan grouping: . thousands, , decimals) */
export function formatMinor(minor: string): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2);
  const cents = digits.slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${grouped},${cents}`;
}
```

If you ever find yourself needing to add two amounts, that is a signal the
backend should be doing it — say so rather than reaching for `Number`.

### The other wire conventions

| Kind | Type | Format | Example |
|---|---|---|---|
| Money | `string` | digits only, minor units | `"9007199254740993"` |
| FX rates | `string` | 8 decimal places | `"757.54060000"` |
| IDs | `string` | UUID v4 | `"d290f1ee-…"` |
| Timestamps | `string` | ISO 8601 date-time | `"2026-03-05T16:30:00.000Z"` |
| Value dates | `string` | ISO 8601 **date** | `"2026-03-06"` |
| Rates (tax/service) | `integer` | basis points | `1600` = 16% |

`fxValueDate` is a **calendar date with no time**. Do not run it through
`new Date()` and reformat in local time — that can shift it a day, and it
identifies which BCV rate applies.

---

## Rule 2: settlement is always VES

A restaurant may price its menu in **VES, USD or EUR**, but every bill is paid
in bolívares.

- `currency` + `totalDue` — what the menu quoted, for display
- `totalDueVes` / `amountPaidVes` / `remainingVes` — **what is actually owed and paid**
- `usdReference` — a convenience string like `"10.00"`, or `null` when no rate
  was available. **Never** use it to compute anything or to display an amount
  due. It is decoration.

The exchange rate is frozen when a bill opens, so a diner's total cannot move
while they eat. Do not re-fetch a rate and re-convert client-side.

---

## Base URL and CORS

Put the API origin in an env var — never hardcode it:

```
VITE_API_BASE_URL=https://<your-api-host>
```

The backend allows **exact origins only**, no wildcards. Every origin the app is
served from (Lovable preview *and* published domain) must be added to the
backend's `CORS_ORIGINS`. If requests fail with a CORS error, that list is the
first place to look.

---

## Staff authentication

```
POST /api/v1/auth/login    { email, password }
  → { accessToken, refreshToken, expiresIn, user }

GET  /api/v1/auth/me       (Bearer accessToken)
  → { user: { id, email, role, restaurantId } }

POST /api/v1/auth/refresh  { refreshToken }
  → a new { accessToken, refreshToken, expiresIn, user }

POST /api/v1/auth/logout   { refreshToken } → 204
```

**On app boot, call `GET /auth/me`. Never call `/auth/refresh` to find out who
the user is.**

Refresh *rotates*: it claims the presented token and issues a new one, and a
token presented after it has already been claimed is treated as theft — which
revokes **every** session for that user. Two tabs booting at once, or a
double-click, will log the user out everywhere. `/auth/me` is a plain read and
is safe to call as often as you like.

**Refresh must be single-flight.** If two requests 401 at the same time, they
must share one refresh, not start two:

```ts
let inFlight: Promise<Session> | null = null;

async function refreshOnce(): Promise<Session> {
  inFlight ??= doRefresh().finally(() => { inFlight = null; });
  return inFlight;
}
```

Getting this wrong reproduces exactly the logout bug above.

Roles are `OWNER`, `MANAGER`, `CASHIER`, `WAITER`. Hide controls the role cannot
use, but treat the server's `403 FORBIDDEN_ROLE` as the real authority — its
`details.requiredRoles` says which roles would have been accepted.

---

## Guest authentication — two headers, not one

A diner scans a table QR, which carries a signed token. Exchange it once:

```
POST /api/v1/guest/sessions   { qrToken }
  → { sessionId, guestToken, restaurantId, tableId, expiresIn }
```

Then **every** guest request carries *both*:

```
Authorization:   Bearer <guestToken>
X-Guest-Session: <sessionId>
```

Sending only one is a `401`. Both headers are already permitted by CORS.

```
GET    /api/v1/guest/bill                → the open bill for that table, with items
POST   /api/v1/guest/bill/split/preview  → split it
DELETE /api/v1/guest/sessions            → end the session (204)
```

**No guest endpoint takes a bill id.** The table comes from the session, so
there is nothing to pass and nothing to tamper with. If you find yourself
wanting to send an id here, you have misread the API.

`404 OPEN_BILL_NOT_FOUND` is the normal state between sittings — show "no open
bill", not an error.

---

## Errors: branch on `code`, never on `message`

Every failure, from every endpoint, is exactly this shape:

```json
{
  "error": {
    "code": "OPEN_BILL_EXISTS",
    "message": "This table already has an open bill",
    "details": { "billId": "0f3c…" },
    "requestId": "9a1e…"
  }
}
```

All four fields are always present. `details` is always an object and often
empty, so `error.details.billId` reads as `undefined` rather than throwing.

`message` is written for humans and will be reworded — **never parse it, never
switch on it, never show it as the only explanation for something the user can
fix.** `code` is the contract.

```ts
if (error.code === 'OPEN_BILL_EXISTS') navigate(`/bills/${error.details.billId}`);
```

Codes worth handling explicitly:

| Code | Status | What the UI should do |
|---|---|---|
| `OPEN_BILL_EXISTS` | 409 | Navigate to `details.billId` instead of creating |
| `BILL_NOT_OPEN` | 409 | Refresh the bill; it was closed or voided elsewhere |
| `PAYMENT_EXCEEDS_BALANCE` | 409 | Re-show `details.remainingVes`; someone else paid first |
| `TOTAL_BELOW_AMOUNT_PAID` | 409 | Refuse the line removal; money has already been taken |
| `BILL_NOT_ITEMISED` | 409 | This bill has a fixed total; open it with `0` to add lines |
| `SPLIT_CLAIMS_INCOMPLETE` | 400 | Highlight `details.unclaimedItemIds` |
| `SPLIT_AMOUNT_MISMATCH` | 400 | Show the gap between `submittedTotalVes` and `outstandingVes` |
| `MENU_CURRENCY_MISMATCH` | 409 | `details.activeProductsInOtherCurrency` still disagree |
| `VALIDATION_FAILED` | 400 | Field errors are in `details.fields` |
| `RATE_LIMITED` | 429 | Back off for `details.retryAfterSeconds` |
| `FX_UNAVAILABLE` | 503 | No BCV rate; a foreign-currency bill cannot be opened right now |
| `AUTH_TOKEN_INVALID` | 401 | Refresh once, then sign out |

Always surface `requestId` somewhere in an error state — it is how a failure is
traced in the server logs.

---

## Screens, in build order

### Staff

1. **Login** — `POST /auth/login`, store the session, then `GET /auth/me` on every subsequent boot.
2. **Tables** — `GET /api/v1/tables`. Create and rename via `POST` / `PATCH` (OWNER, MANAGER only).
3. **Menu** — `GET|POST|PATCH|DELETE /api/v1/menu/products`, and `GET|PATCH /api/v1/menu/settings`. Deleting is a soft deactivate.
4. **Open a bill** — `POST /api/v1/bills` with `{ tableId, totalDueMinorUnits }`.
   Send **`"0"`** for an itemised bill. A non-zero fixed total permanently blocks line items on that bill.
5. **Bill detail** — `GET /api/v1/bills/{id}` returns the bill *with* its lines. Add, change and remove lines with `POST|PATCH|DELETE /api/v1/bills/{id}/items`. Each of those returns the recalculated bill, so never re-derive a total.
6. **Split** — `POST /api/v1/bills/{id}/split/preview` (below).
7. **Take payment** — `POST /api/v1/bills/{id}/payments` (below).

Show the breakdown on the bill, not just the total: `subtotalMinor`,
`vatMinor` (labelled with `vatBps`, e.g. "IVA 16%"), `serviceChargeMinor`, then
`totalDue`. They sum exactly — the database refuses a row where they do not.

`GET /api/v1/bills` (the list) deliberately omits line items so listing stays
cheap. Only the single-bill read includes them.

### Guest

This is what a table QR opens. The printed code points at **this app**, not at
the API:

```
scan → https://your-app/t?qr=<token>
```

1. **Landing (`/t`)** — read `qr` from the query string and `POST /guest/sessions`
   with it. Store `sessionId` and `guestToken`, then redirect to the bill. Do not
   leave the token in the URL afterwards; replace the history entry.
   A `401 QR_INVALID` means the code was rotated or altered — say "ask staff for
   a new code", not "something went wrong".
   The route name is baked into every printed sticker, so settle it before
   anyone prints: whatever you choose goes in `QR_APP_PATH` when the codes are
   minted.
2. **Bill** — `GET /guest/bill`. Show the lines, then `subtotalMinor`, `vatMinor`
   labelled with `vatBps` ("IVA 16%"), `serviceChargeMinor`, and `totalDue`.
   Poll every few seconds while the screen is open; there is no realtime channel,
   and the bill changes as staff add items.
   `404 OPEN_BILL_NOT_FOUND` is normal between sittings — show "no open bill",
   not an error.
3. **Split** — `POST /guest/bill/split/preview`. Let the diner pick a mode,
   render `allocations` exactly as returned, and never compute a share locally.

**Paying is not yet possible.** There is no guest payment endpoint: a diner can
see their share and cannot settle it, and a member of staff takes the money.
Build the guest flow to end at "this is what you owe" and leave room for a pay
step rather than stubbing one — the shape of that screen depends on the rail,
which is still being chosen.

> **A guest cannot pay yet.** There is no guest payment endpoint. The diner sees
> their share and a member of staff settles the bill. Design the guest flow to
> end at "here is what you owe" for now.

---

## Splitting

```
POST /api/v1/bills/{id}/split/preview
POST /api/v1/guest/bill/split/preview
```

```json
{
  "mode": "EQUAL",
  "participants": [{ "id": "p1", "name": "Ana" }, { "id": "p2" }]
}
```

`id` is yours — any stable opaque string, unique within the request. It is not
stored server-side yet.

| Mode | Extra input |
|---|---|
| `FULL` | exactly one participant |
| `EQUAL` | none |
| `ITEMS` | `claims: [{ itemId, participantIds: [...] }]` — **every line must be claimed**; more than one claimant splits that line between them |
| `CUSTOM` | `amountVes` on each participant; they must sum to `outstandingVes` **exactly** |

Response:

```json
{
  "mode": "EQUAL",
  "currency": "VES",
  "outstandingVes": "7567",
  "totalAllocatedVes": "7567",
  "allocations": [
    { "participantId": "p1", "name": "Ana", "amountVes": "2523", "usdReference": "0.03" }
  ]
}
```

Every mode divides the **same** figure — `outstandingVes`, what is left to
settle — so you never have to work out which number was split.

**This is advisory. It moves no money.** Nothing is reserved; two people can
still both try to pay the same share, and the second is refused with
`PAYMENT_EXCEEDS_BALANCE`.

**Do not implement any of this arithmetic in the client**, including a "quick
equal split" preview. The allocation is largest-remainder so the parts sum to
the total exactly; a naïve `total / n` leaves the last person unable to pay.
Render `allocations` as given. `totalAllocatedVes` always equals
`outstandingVes` — assert it if you like, but never recompute it.

---

## Payments

```
POST /api/v1/bills/{id}/payments
Idempotency-Key: <uuid>

{ "billId": "<same as the path>", "amountMinorUnits": "250000", "currency": "VES", "idempotencyKey": "<same uuid>" }
```

Roles: OWNER, MANAGER, CASHIER.

**Generate the idempotency key once per payment attempt and reuse it on every
retry.** That is the entire point — replaying a completed key returns the stored
response instead of charging twice. Generating a fresh key on retry defeats it
and can double-charge. Reusing a key with a *different* body is a `409`.

`billId` in the body must match the path, or you get `400 BILL_ID_MISMATCH`.

`currency` is always `"VES"`.

---

## Things not to build

- Any client-side money arithmetic, including tax, service charge or splits.
- A local re-implementation of "divide by n".
- Parsing or switching on `error.message`.
- Calling `/auth/refresh` to identify the user.
- Concurrent refresh calls.
- Regenerating an idempotency key on retry.
- A guest payment screen — the endpoint does not exist yet.
- Re-fetching an exchange rate to re-convert a bill; the rate is frozen per bill.

---

## Reference

- `openapi.json` — the contract, committed and CI-checked
- `GET /openapi.json` — the same document, served live
- `GET /docs` — Swagger UI, while `DOCS_ENABLED=true`
