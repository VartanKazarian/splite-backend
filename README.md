# Splite Backend

A Venezuela-focused bill-splitting API. Settlement is always in bolívares;
menus may be priced in VES, USD or EUR, and the rate is frozen when a bill
opens so a diner's total cannot move while they eat.

## What is built

**Security foundation**

- Express API with hardened headers, strict CORS and per-request correlation ids
- PostgreSQL schema managed through versioned, transactional migrations
- Multi-tenant restaurant / user / table / bill model, tenant-scoped on every query
- Argon2id password hashing with constant-time failure paths
- Short-lived access JWTs plus rotating refresh sessions with reuse detection
- Redis-backed rate limiting, fail-closed on the auth surface
- RBAC: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`
- Signed, expiring, rotatable QR tokens; hashed guest session tokens
- Guest bill access scoped to the scanned table, naming no resource ids
- Audit logging with actor, tenant, IP and request id

**Money**

- VES-only settlement with exact BigInt arithmetic and largest-remainder splits
- Menus priced in VES, USD or EUR, at the BCV rate in force, never guessed
- Bill line items with immutable price snapshots; totals derived, never supplied
- A split engine with four modes — FULL, EQUAL, ITEMS and CUSTOM
- Persistent splits: participant shares stored and settled independently, each
  under its own database-enforced ceiling
- Mercantil C2P charging with safe in-doubt resolution (wire format unconfirmed)
- Append-only payment ledger with a database-enforced state machine
- Payment concurrency control via `SELECT ... FOR UPDATE`
- Idempotency keys on money-moving endpoints
- Tips recorded on the payment, never on the bill, with a per-shift report that
  separates what is in the till from what is owed to staff

**Contract**

- OpenAPI 3.1 document, committed as `openapi.json` and enforced by tests
- camelCase on the wire, snake_case in the database, crossed in exactly one place
- One error envelope for every failure, with codes clients branch on

**Operations**

- Multi-stage Docker image running as a non-root user; hardened Compose stack
- Railway deployment config, with migrations as a pre-deploy step
- Node 22; CI: syntax check, OpenAPI drift check, unit tests, dependency audit,
  invisible-character guard, image build

Restaurants arrive through a reviewed registration form rather than a seed
script — see [Registering a restaurant](#registering-a-restaurant).

Bills settle from four directions — the till, a diner's declared Pago Móvil, a
Mercantil C2P charge, and a signed provider webhook — all through one settlement
function. See [Getting paid](#getting-paid). **Card payments are not built**:
that needs an acquirer.

Not yet built: card payments, and automatic bank reconciliation. See
[Open points](#open-points).

## Local development

```bash
cp .env.example .env
npm install
docker compose up -d db redis
npm run migrate
SEED_OWNER_EMAIL=owner@example.com SEED_OWNER_PASSWORD=a-long-dev-password npm run seed
npm test
npm start
```

Without Docker, `npm run db:local` starts a user-space PostgreSQL and Redis on
non-default ports — no daemon, no `sudo` — and `npm run test:integration:local`
runs the integration suite against them. `npm run db:local:stop` shuts them down.

The integration tests skip unless `RUN_INTEGRATION=1` and a live database are
present, so `npm test` stays fast and offline.

Generate production secrets with:

```bash
npm run secrets
```

It prints four 512-bit values and writes nothing to disk. The app refuses to
start in production with missing, short, duplicated or placeholder secrets.

The seed's email is validated against the same rule `/auth/login` uses, because
they used to disagree: Joi checks the TLD against the IANA list, so a plausible
address like `owner@splite.test` seeded happily and was then refused at every
sign-in — which reads as a broken password rather than a rejected address.

## API

The API is described by an **OpenAPI 3.1 document**, which is the contract:

| | |
| --- | --- |
| `openapi.json` | committed at the repository root, so a client can be generated without the API running |
| `GET /openapi.json` | the same document, served live |
| `GET /docs` | Swagger UI |

`test/openapi.test.js` fails the build if a mounted route is missing from the
document, or the document promises a route the app does not serve. It also
enforces that every operation declares its authentication, names its roles in
`x-required-roles`, and documents the error responses a client must handle
(`400/401/403/404/409/429/500`, as applicable).

The endpoint table that used to live here has been removed rather than kept
alongside the spec. It had already drifted: three `/api/v1/tables` endpoints were
documented for several commits while the router was not mounted at all, and
`GET /api/v1/tables` returned 404. Two hand-maintained lists disagree eventually;
one generated contract with a test behind it does not.

`npm run openapi:check` fails if the committed `openapi.json` has drifted from
the code, so the artifact a frontend generates from cannot fall behind the API
it describes. Regenerate it with `npm run openapi:dump`.

Set `DOCS_ENABLED=false` to withhold both served endpoints; the committed file
is unaffected.

Monetary amounts cross the wire as **strings**, because a JSON number has
already lost precision past 2^53 by the time it arrives. Payments accept an
`Idempotency-Key` header (or `idempotencyKey` in the body); replaying a
completed key returns the stored response instead of charging twice.

A claim is only ever granted with a row behind it. If the key's row is deleted
between the conflicting insert and the read that follows — a failing request's
`abort()` racing a client's retry does exactly that — the claim is re-attempted
rather than granted on trust. Granting it left the caller holding a claim with
nothing to store a response in, so the next retry found no row either and
charged again. Storing that response is loud but never fatal: it runs after the
money has moved, and throwing would reach the route's abort and free the client
to retry a request that already succeeded.

## When BCV cannot be reached

A foreign-currency bill needs a rate to have a settleable total, so the rate is
fetched and frozen when the bill opens. The question is what to do when
bcv.org.ve does not answer, which in Venezuela is not rare.

It used to refuse outright, on the reasoning that serving an old rate as if it
were current is the failure this service exists to prevent. That is right for a
rate that moves continuously and wrong for this one: **BCV publishes at most
once per business day**, so between publications the figure in `fx_rates` is not
a stale copy of the current rate, it *is* the current rate. Refusing it meant a
third-party website being down stopped a restaurant opening any USD bill — the
product unavailable while the correct number sat in our own database.

So the fetch failing falls back to the newest stored rate whose value date has
already arrived, and the same happens when the deviation guard rejects a fetched
rate: having decided not to trust the new number, the last one we did trust
beats none.

Bounded at `FX_MAX_FALLBACK_AGE_DAYS` (5), because the reasoning stops holding
once an outage outlives a publication cycle. Past that the figure really has
stopped being true, and in an economy that devalues, quietly pricing bills on it
is worse than declining to open one: a restaurant told "no rate available" calls
somebody, a restaurant undercharging by a third for a fortnight does not notice
until it counts the money.

The bill records how the rate was obtained — `fxRateSource` reads
`BCV_LAST_IN_FORCE` rather than `BCV` — because "where did this number come
from" is exactly the question asked afterwards.

## Guest sessions

Scanning the QR exchanges it for a session held in Redis, and only the SHA-256
of the token is stored.

The TTL is an **idle timeout, not a total lifetime**: every authenticated
request pushes it back. It was previously set once at creation and never
touched, so a session died two hours after the scan regardless of what the diner
was doing — which is sitting at the table, for longer than two hours, with the
expiry landing at the one moment it had to work: opening the phone to pay. And
it was unrecoverable in practice, because the client strips the QR token out of
the URL after exchanging it and so has nothing left to mint a new session with.
The diner had to get up and scan the sticker again.

`GUEST_MAX_SESSION_AGE_SECONDS` (12h) is the ceiling sliding cannot pass.
Without it, "renew on every use" means a session something keeps touching — a
tab open on a phone in a drawer, a client polling on a timer — never expires at
all. A session past the ceiling is deleted rather than left to lapse: a
credential known to be dead should not sit in the store.

Sessions live only in Redis, so a Redis restart drops every one of them
mid-service. Diners recover by re-scanning, which works because the QR is
permanent — but see [Open points](#open-points): binding sessions to the open
bill is the durable fix.

## Bill lifecycle and the one-open-bill rule

A restaurant table has **at most one `OPEN` bill**, enforced at two levels:

1. `POST /api/v1/bills` locks the table row with `FOR UPDATE`, checks for an
   existing open bill, and only then inserts.
2. A partial unique index on `(restaurant_id, table_id) WHERE status = 'OPEN'`
   catches the race the application cannot see.

A duplicate attempt returns `409` with `code: OPEN_BILL_EXISTS` and the existing
bill id. `GET /api/v1/bills/tables/:tableId/open` resolves a table to its
current bill, which is what makes a permanent physical table QR usable.

Closing or voiding a bill releases the table for the next one; the partial index
only covers `OPEN`, so history is retained. Migration 004 also adds a composite
foreign key so a bill's table must belong to the same restaurant as the bill.

## Menu and menu currency

A restaurant prices its menu in `VES`, `USD` or `EUR`. This says only what the
printed prices are denominated in — **Splite settlement is always VES** either
way, and nothing here changes how a bill settles.

A product's currency is copied from the restaurant at creation and is not
accepted from the request, so a product can never disagree with the menu it
belongs to. Changing the menu currency is refused with `409
MENU_CURRENCY_MISMATCH` while any active product still uses the old one:
converting prices automatically would mean guessing a rate on the restaurant's
behalf, and leaving them would mean a menu quoting two currencies at once.

Deleting a product deactivates it rather than removing the row, because a bill
that already references it has to stay readable.

`GET /api/v1/menu/public/:restaurantId/products` is the one unauthenticated
endpoint here: a guest scanning a table QR has no staff credentials.

## Wire format

The public API is **camelCase**; PostgreSQL is snake_case. `src/dto.js` is the
only place allowed to cross between them, and `test/openapi.test.js` fails on
any documented field containing an underscore.

| Kind | JSON type | Format | Example |
|------|-----------|--------|---------|
| Money (minor units) | `string` | digits only | `"9007199254740993"` |
| FX rates | `string` | padded to 8 decimals | `"757.54060000"` |
| IDs | `string` | UUID v4 | `"d290f1ee-..."` |
| Timestamps | `string` | ISO 8601 date-time | `"2025-03-05T16:30:00.000Z"` |
| Value dates | `string` | ISO 8601 **date** | `"2025-03-06"` |

Amounts are strings because a JSON number past 2^53 has already lost precision
by the time it is parsed. Rates are strings so one representation is returned
everywhere — `GET /exchange-rate` used to answer `757.5406` while a bill
reported `"757.54060000"` for the same rate.

Value dates are date-only for a sharper reason. node-pg parses a `DATE` column
into a JS `Date` at *local* midnight, so serialising it directly produced
`"2025-03-06T04:00:00.000Z"` on a Caracas host and `"...T00:00:00.000Z"` on a
UTC one: one row, two strings, depending on where the process ran. A client
formatting that in its own zone can land a day early — and for a BCV value date
that selects a different published rate.

The mappers are written out field by field rather than generated by a
snake-to-camel transform. A generic transform would make the wire contract a
derived function of column names, so a rename would silently rename a public
field, and `{ ...row }` publishes whatever the `SELECT` happened to fetch —
`qr_nonce` and `password_hash` are one careless `SELECT *` away.

## Errors

Every failure is the same object. `src/middleware/errorHandler.js` is the only
place that renders one, and every error reaches it by being thrown or passed to
`next()`, so the shape is guaranteed by construction rather than by each route
remembering it.

```json
{
  "error": {
    "code": "OPEN_BILL_EXISTS",
    "message": "This table already has an open bill",
    "details": { "billId": "0f3c..." },
    "requestId": "9a1e..."
  }
}
```

**Branch on `code`, never on `message`.** Messages are written for humans and
get reworded; codes are the contract. `src/errors.js` is the registry, a code
always carries the same HTTP status, and constructing an unregistered one
throws rather than reaching a client as an unmatchable string.

```js
if (error.code === "OPEN_BILL_EXISTS") navigate(`/bills/${error.details.billId}`);
```

`details` is always an object and often empty, so `error.details.billId` reads
as undefined instead of throwing. `requestId` is always present and matches the
`REQUEST_FAILED` log line. What each code carries is published in the OpenAPI
document as `x-error-details`, generated from the registry rather than written
by hand.

5xx messages are always the literal `"Internal Server Error"` — unexpected
errors carry driver, query and file-path detail, so only the code and the
requestId cross the wire. The real message stays in the logs.

This replaced four shapes that were live at once: a bare string, `{ message,
requestId }`, an array of validation strings, and a string with `code` and
`billId` as *siblings* of `error` — so a client could not destructure a failure
without first knowing which route produced it.

## Registering a restaurant

A reviewed lead, not self-service. Behind `ONBOARDING_ENABLED`; while the flag
is off the routes are not mounted at all.

```
POST /api/v1/onboarding/restaurants   -> 202   records a lead, emails the team
   (a person reads it and telephones the restaurant)
npm run onboarding -- invite <id>              mails the single-use link
POST /api/v1/onboarding/verify        -> 201   creates everything, signs them in
```

**The form creates nothing.** No tenant, no account, no token. It records the
submission and emails the onboarding team the name, RIF, address, phone and the
qualifying answers, so somebody can read it and pick up the phone. The applicant
gets an acknowledgement saying a person will call, and no link.

There is deliberately no HTTP route for the invite step. Every authenticated
surface in this API is scoped to a restaurant the caller belongs to, and there is
no platform-operator role — inventing one to serve a handful of approvals a week
would be a second authentication model to secure and keep correct forever. The
team uses:

```bash
npm run onboarding -- list NEW
```

then `show <id>`, `contacted <id> [notas]`, `invite <id>`, `reject <id> [notas]`.

**`restaurants` and `users` are still only created inside the transaction that
spends the token**, even though a human has already vouched for the lead. Being
vouched for is not the same as controlling the inbox, and migration 002 made
staff email globally unique:

```sql
CREATE UNIQUE INDEX users_email_unique_idx ON users (lower(email))
```

so an insert before the address is proven would let anyone permanently claim an
address they cannot read, and nothing in the codebase releases one afterwards.

Consequences worth knowing before changing any of it:

| Decision | Why |
| --- | --- |
| Phone is required | The next thing that happens to a lead is a phone call. Validated loosely — `+58 412 1234567`, `0412-1234567` and `04121234567` are one line written three ways, and rejecting two of them loses the restaurant rather than teaching it ours. |
| No password until the link | A credential stored against an unproven address, and Argon2id at 19 MiB per call on an endpoint anyone can reach. The invitation token *is* the set-password token. |
| Identical 202 either way | An endpoint that says "that email is taken" is an account-enumeration oracle. `/auth/login` pays for a decoy Argon2 hash to close exactly this. Duplicates are flagged to the reviewer instead, which is where a human should be looking at them. |
| One error code for the token | `ONBOARDING_TOKEN_INVALID` covers absent, spent and expired. A caller has no use for the difference and separating them reveals which links exist. |
| Two rate limiters | Per source address bounds submissions. It does nothing about the other abuse — this endpoint mails an address the *caller* chooses, so a distributed caller stays inside any per-IP budget while filling one person's inbox. The per-recipient limiter stops that. Both fail closed. |
| RIF checksum recorded, not enforced | The mod-11 rule is implemented here for the first time and unproven against real data. Turning away a real restaurant at the form is worse than storing one malformed tax id; the reviewer is shown the mismatch and decides. Note `J-00000000-0` passes — it catches transcription slips, not invention. |
| Trial reported, never enforced | `GET /api/v1/account` returns `plan.trialEndsAt` and `trialDaysRemaining` so a client can warn. Nothing refuses service when it lapses: which action a lapsed restaurant loses is a pricing decision, and the obvious candidate is wrong — cutting off bills mid-service strands a dining room full of seated diners over an unpaid invoice. |

A restaurant is created with IVA at 1600 bps and servicio at 1000 bps. Migration
011 defaults both to zero so that running it could not reprice an existing
restaurant's open bills; one created today has no such history. Both are
changeable through `PATCH /api/v1/menu/settings/charges`.

Mail goes through `src/services/mailer.js`, a port with two adapters. `log`
writes the message and its link to the logger and sends nothing; it is refused
in production once onboarding is on. `resend` posts to api.resend.com over
`fetch`. Adding SES or Postmark means adding a function to `TRANSPORTS` and
nothing else. Picking a provider also means a domain with SPF and DKIM — without
it the mail goes to spam and the team never learns a restaurant applied.

## Sessions

`POST /api/v1/auth/login` returns an access token, a refresh token and the user.
A client restoring a session on boot calls **`GET /api/v1/auth/me`**, not
`/auth/refresh`.

That distinction matters more than it looks. Refresh *rotates*: it atomically
claims the presented token and issues a new one, and a token presented after it
has already been claimed is treated as theft, which revokes **every** session for
that user. Two browser tabs starting at once both present the same stored token
— one claims it, the other is read as theft, and the user is logged out
everywhere. So refresh is for renewing an expired access token, and nothing else.

`/auth/me` reads the user from the database rather than the token, so an account
deactivated mid-session stops working inside the access token's fifteen minutes
rather than at the end of them. It returns the same `user` shape as login and
refresh, so a client stores one type.

## Bill line items

A line's price is **snapshotted when it is added** and never read from the menu
again, so re-pricing, renaming or deactivating a product cannot change a bill
that has already been served. `product_id` is kept for reporting and is
nullable: the line outlives the product.

`subtotal_minor` is `GENERATED ALWAYS AS (unit_price_minor * quantity) STORED`
— the database computes it or nothing does. A subtotal the application keeps in
step with its inputs is the same drift the payment ledger exists to remove.

Every mutation recomputes the bill total from its lines and re-converts at the
rate **frozen when the bill opened**, never at today's rate: otherwise adding a
coffee silently reprices the meal. Removing a line that would drop the total
below what has already been settled is refused with `TOTAL_BELOW_AMOUNT_PAID`,
because reversing money that has moved is a refund, not an edit.

Items are optional. A bill opened with a fixed non-zero total refuses
itemisation (`BILL_NOT_ITEMISED`) rather than silently discarding that figure or
counting the bill twice — open it with a total of `0` to itemise it. A composite
foreign key on `(bill_id, restaurant_id, currency)` ties every line to its bill,
its tenant and its currency at once, so a EUR line cannot sit on a USD bill.

## Building a menu from a photo

`POST /api/v1/menu/ocr-extract` takes a photo or PDF of a menu (multipart, field
`file`) and returns the items a vision model read off it. **It writes nothing.**
`POST /api/v1/menu/ocr-import` is the write, and it takes what a staff member
confirmed on screen — not what the model said.

That division is the feature, not friction around it. It is the same one a
declared Pago Móvil uses: the machine records what it thinks, a person turns it
into a fact. OCR misreads prices, and a wrong price on a menu is charged to
every diner who orders that dish until somebody notices.

Three things follow from treating the extraction as a draft:

- A row whose price could not be read arrives with `priceMinorUnits: null` and
  `needsPrice: true` rather than being dropped. The item is real; hiding it
  sends staff hunting for what the reader missed.
- Rows sharing a name are flagged `duplicateName`, because `menu_products` is
  unique on `(restaurant_id, name)` and one of them has to be renamed before
  either can import.
- `currencyGuess` is reported and never applied. Prices import in the
  **restaurant's** `menu_currency`; a menu printed in dollars does not change
  what that restaurant charges in, and the request cannot name a currency at all.

Import is per row inside a savepoint, so one duplicate name rejects that row and
keeps the other forty-nine — read `errors` as well as `importedCount`. Without
the savepoint the first duplicate would abort the transaction and every later
insert would fail with `25P02`, which is why a plain try/catch around the insert
cannot do what it appears to.

### Reading prices

A menu writes the same number several ways, and getting this wrong is expensive
in a direction nobody checks:

| Printed | Read as |
| --- | --- |
| `12,50` / `12.50` | 12,50 |
| `1.234,56` / `1,234.56` | 1.234,56 |
| `1.500` / `1,500` | 1.500,00 — three trailing digits group thousands |
| `25` | 25,00 — a menu never quotes céntimos |
| `a la carta` | `null` — needs a human |

Deliberately not the bank parser in `src/payments/providers/mercantil/c2p.js`,
which solves a similar problem with one decisive difference: a bank sometimes
quotes minor units, so a bare `25` there is twenty-five céntimos. Sharing them
behind a flag would mean reading that flag wrongly exactly once, silently.

### Operating it

Off unless configured: without `MENU_OCR_API_KEY` the endpoint answers 503
`MENU_OCR_NOT_CONFIGURED` rather than failing oddly at upload. `MENU_OCR_BASE_URL`
selects the provider — the request is the OpenAI-compatible chat-completions
shape several vendors serve, so switching is configuration rather than code.

Rate limited to 10 uploads a minute per staff member: each call costs money at a
third party. Uploads are bounded (8 MB, 6 PDF pages) and held in memory only —
no menu image is ever written to disk or to the database. A PDF is rasterised
with `pdftoppm` (poppler, in the image) because a menu PDF is usually a design
export whose text layer is absent or ordered by drawing position rather than
reading order: the picture carries what extracted text loses.

`pdftoppm` is the one thing here that is not a Node dependency. It is installed
in the runtime image and in CI; without it, image uploads still work and a PDF
answers 400 `MENU_OCR_PDF_UNREADABLE` rather than failing obscurely. The
integration test for that path skips when the binary is absent, so a developer
without poppler sees a skip rather than a spurious failure.

## Charges: IVA and servicio

A bill total is not just the sum of its lines. Both charges are configured per
restaurant in **basis points** as integers — `1600` is 16%, `1000` is 10% — and
are **snapshotted onto the bill when it opens**, for the same reason the FX rate
is: changing a restaurant's rates must never reprice a meal already eaten.

```
  subtotal          sum of the line items
+ IVA               vat_bps x subtotal
+ service charge    service_charge_bps x subtotal, NOT taxed
= total
```

**IVA is not charged on the servicio.** Both are taken on the subtotal
independently and summed; the service charge never enters the taxable base.
Compounding them — taxing subtotal + service — overstates IVA on every bill, so
there is an explicit test asserting a $100 subtotal at 16/10 totals 126.00 and
not 127.60.

`CHECK (total_due = subtotal_minor + service_charge_minor + vat_minor)` means a
total that disagrees with its parts cannot be stored at all, by the application
or by anything else. Every insert has to write a consistent row.

Both rates default to **zero**, including for Venezuela's statutory 16%: a
restaurant is configured deliberately, and a migration must never silently move
an existing total.

A voluntary tip is deliberately not modelled here. It is untaxed and chosen by
the payer rather than the restaurant, so it belongs with the payment — see
[Tips](#tips).

## Where the money goes

Splite never holds it. A Pago Móvil goes from the diner's account to the
restaurant's, so the payee is not administrative trivia — without it the bill
screen shows what is owed and offers no way to pay it.

```
PUT /api/v1/account/payout      bankCode, accountNumber, phone, holderId
GET /api/v1/account/banks       the picker, with integration status
```

OWNER and MANAGER only. This is the address money is sent to: getting it wrong
does not degrade the product, it pays a stranger.

Four fields together or none, enforced in the schema *and* by a CHECK. A
half-filled payee looks configured on screen and cannot receive money, and that
failure lands on a diner holding a phone rather than on whoever filled in the
form. `{}` clears it.

A Venezuelan account number begins with its own four-digit bank code, so
`accountNumber` and `bankCode` are one fact typed twice and are checked against
each other — which catches the right account entered under the wrong bank in the
picker, an error that would otherwise surface as a payment that never arrives.

`holderId` is recorded rather than taken from `restaurants.rif`: plenty of small
restaurants bank on the owner's cédula. It accepts `V E J G P C` — the union of
our original list and the one in Mercantil's own C2P form, which offers `C` and
omits `E`. Turning away a legitimate account holder at a configuration screen is
the expensive error.

`phone` must be a **mobile** line — `0412`, `0414`, `0416`, `0424`, `0426`,
confirmed against that same form. A landline cannot receive a Pago Móvil at all,
so accepting one configures a payee that can never be paid, and the diner finds
that out rather than the restaurant.

**The diner is not shown the account number.** A Pago Móvil is addressed by
bank, phone and identity document; the account number adds nothing to it, and
anyone who scans a sticker on a table reaches the guest surface. `dto.payout`
and `dto.guestPayee` are separate mappers for that one reason.

### Banks are not one integration

`src/payments/banks.js` is the registry, and `integration` on each entry is the
honest part: `null` means we have no module for that bank. **Every entry is null
today.** A restaurant may name any bank — that is where diners send money
whether or not we have an API — but only a bank with a module can take part in
an in-app payment, and `chargeable` on the API says which is which.

There is no such thing as "the bank API" here. Each bank exposes its own, with
its own credentials, its own field encryption, and its own idea of what a
payment reference is. Mercantil's C2P, for instance, takes a merchant id, client
id, secret key, integrator id and terminal id — **one set per restaurant** — and
encrypts the identity document, both phone numbers and the payment key with
AES-128-ECB before sending. That is one integration. Banesco is another.

> **The bank list is still unverified.** An attempt to check it failed:
> `sudeban.gob.ve`, `www.sudeban.gob.ve` and `cbn.org.ve` do not respond, and
> `bcv.org.ve` — which is reachable — publishes no institution-code table. The
> dead ends are recorded in `src/payments/banks.js` so nobody repeats them; what
> is left is a Sudeban PDF via a mirror, or asking a bank directly, since
> Mercantil gives its integrators the `destination_bank_id` list.
>
> The cross-check limits the damage meanwhile: an account number carries its own
> bank's code, so a wrong name-to-code pairing shows up as a rejected form at
> configuration time rather than as misdirected money. The hole it does not
> cover is two banks transposed — both would validate. No payment path uses
> these codes today, so **confirming the list is a prerequisite for the first
> bank module, not for the first restaurant.**

### Bank API credentials

Separate from the payee for a reason that is not tidiness. Those fields are
readable by design, some of them by anyone who scans a table QR; these are the
only values in the system that let software move a restaurant's money, and they
are issued by the bank to the merchant, so we cannot rotate them if they leak.

```
GET    /api/v1/account/payment-providers
PUT    /api/v1/account/payment-providers/{provider}
DELETE /api/v1/account/payment-providers/{provider}
```

**OWNER only** — not MANAGER, who may set the payee. Saying where money should
be sent and letting software move it are different kinds of authority.

Sealed with **AES-256-GCM** before reaching the database, in
`src/payments/credentials.js`. Not the AES-128-ECB Mercantil specifies for
fields inside its own request bodies: ECB is deterministic and unauthenticated,
which is fine to implement when a counterparty requires it for a phone number in
transit and wrong for something we choose ourselves for data at rest. GCM
detects tampering, and a modified credential fails loudly rather than decrypting
into one that talks somewhere else.

**Nothing returns a credential.** There is no read endpoint, and
`dto.paymentProviderConfig` has no field that could carry one — `configured` is
a boolean because the alternative, a masked tail like `sk_live_••••4821`, is a
leak with a decoration on it, and the four characters shown are the four an
attacker needed to confirm a guess. `loadCredentials` is the single function
returning plaintext; it is reachable only from `src/payments/`.

The credential set is an **opaque sealed blob**, not columns. No two banks agree
on what a credential is: Mercantil issues five fields, the next bank will issue
a different number with different names, and a schema trying to be the union of
all of them means a migration per bank plus a row of nulls for every bank that
does not use them. The shape lives in a per-provider registry in
`src/payments/providerConfigs.js`; adding a bank is an entry in that object.
Unknown fields are rejected rather than stored — a blob that carries whatever
was sent is where a stray password ends up, sealed forever and invisible to
review.

Two rules the database enforces rather than trusting the service to remember:

- **Storing credentials does not switch a rail on.** `enabled` defaults to
  false, and replacing credentials resets it. New credentials are unproven
  credentials however good the old ones were, and a mistyped secret key must not
  leave a rail on and quietly broken.
- **A rail cannot be enabled on credentials nobody has proven.** `CHECK (NOT
  enabled OR credentials_validated_at IS NOT NULL)`. Only a real call to the
  bank sets that timestamp — there is no endpoint for it, because "these
  credentials work" is a fact an adapter establishes by using them, not a
  checkbox somebody ticks.

Keys are a ring, `PAYMENT_CREDENTIALS_KEYS=1:<key>,2:<key>` with
`PAYMENT_CREDENTIALS_ACTIVE_KEY_VERSION`. The interesting moment is not the
first encryption but the rotation years later: add a version, point the active
version at it, and `providerConfigs.rotate()` re-seals old rows in batches. Each
row records the version that sealed it, so that query uses an index instead of
decrypting everything to ask.

The key is read lazily and never asserted at boot. Most deployments will never
store bank credentials, and a missing key must break storing them rather than
break starting the app — it answers 503 `PAYMENT_CREDENTIALS_KEY_MISSING`, which
says configuration rather than bug.

## Getting paid

Four ways money reaches a bill, and they all settle through **one** function —
`applyToBill` in `src/services/locks.js`. That matters: the rules are that a
bill must be OPEN, that the running total may never exceed what is due, and that
CLOSED happens on exact equality and nowhere else. Each path had a reason to
write its own version, and each version was subtly different — `>=` instead of
`===` closes a bill on an overpayment and swallows the difference, and an
omitted status check settles a bill that was voided an hour ago.

| Path | Who says the money arrived | Verified by |
| --- | --- | --- |
| `POST /api/v1/bills/:id/payments` | staff at the till | the person taking it |
| `POST /api/v1/guest/bill/payment-claims` → `confirm` | the diner | a person with the bank app open |
| `POST /api/v1/guest/bill/c2p` | Splite, on the diner's instruction | Mercantil's charge response, or staff resolving an in-doubt one |
| `POST /api/v1/webhooks/:provider` | the provider | an HMAC signature |

The C2P path is the only one where Splite **initiates** the debit rather than
being told about money after it moved, which is what makes it the delicate one —
see [Mercantil C2P](#mercantil-c2p) below.

### How a payment reaches a table

`payments` carries `restaurant_id` and `bill_id`, and **no `table_id`**. The
table is reached through the bill, because a payment belongs to a bill and the
bill is what sits on a table; a copy of `table_id` on the payment would be a
second record of the same fact, and two records of one fact drift.

```
payments.restaurant_id ─────────────────→ restaurants.id
payments.bill_id ───────────────────────→ bills.id
                          bills.table_id ─┐
                     bills.restaurant_id ─┴─→ tables (restaurant_id, id)
```

Both links are composite foreign keys, so a row cannot name one restaurant while
pointing at another's record — `bills_table_same_restaurant_fk` (migration 004)
and `payments_bill_same_restaurant_fk` with
`payment_transitions_payment_same_restaurant_fk` (migration 016). Every write
path already re-reads the bill under `WHERE id = $1 AND restaurant_id = $2`, but
that is discipline in application code; these are the guarantee, and this is the
table that holds money.

Which restaurant and table a payment belongs to is never taken from the request
body:

| Path | Restaurant from | Table from |
| --- | --- | --- |
| Staff | `req.user.restaurantId`, in the JWT | the bill named in the URL |
| Diner | the guest session | the guest session |
| Webhook | the signed body, then re-checked against the payment row | the payment's bill |

The diner's case is the strictest and worth stating plainly: **a guest never
names a bill.** Their session comes from a signed QR carrying `tableId` and
`restaurantId`, and the open bill is resolved with
`WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'`. There is no
identifier to tamper with, and the partial unique index on
`(restaurant_id, table_id) WHERE status = 'OPEN'` is what makes table → bill a
function rather than a guess.

### Declared Pago Móvil

Splite never touches this money — it goes from the diner's bank to the
restaurant's — so no API of ours can watch it arrive. A diner declares a payment
and a reference; that creates a `payments` row in **PENDING** and touches
`bills.amountPaidVes` not at all. A bill that showed itself as paid because
somebody typed a number into a form would be worse than one showing nothing,
because the restaurant would stop asking.

Staff work the queue at `GET /api/v1/payments/claims` and either confirm
(OWNER/MANAGER/CASHIER — a waiter can take an order, deciding money arrived is a
cashier's job upwards) or reject with a reason.

References are normalised to digits and hold a partial unique index per
restaurant, excluding FAILED and CANCELLED. That closes the cheap attack —
table A reads their reference aloud, table B with an identical total types the
same number, and a member of staff glancing at a phone confirms both — while
still letting a diner who mistyped correct it after a rejection.

A claim is **not** a reservation. Two diners may each claim the whole balance;
only the first confirmation can succeed, and the second gets 409.

**A refusal from the share is not a refusal from the bill.** When a claim names
a split share and that share can no longer take the money — the split went stale
or was voided while the claim sat in the queue — the bill is still credited and
the attribution is dropped, reported as `shareDetached`. Staff have found this
transfer in the bank account, so its arrival is not in question, only where to
file it; rolling the whole confirmation back left verified money stuck PENDING
with no path to the bill at all, permanently, since a refusal about the *plan*
cannot be argued with by retrying. The payment's `split_participant_id` is
cleared rather than left dangling, because a settled payment still naming a
share it never credited reads as permanent drift in `bill_split_share_drift`.
The C2P rail deliberately answers the same refusal differently: there we
initiated the debit, so the charge is parked for a person.

### Mercantil C2P

The first rail where Splite asks for money to move rather than being told it
already did. The diner obtains a single-use *clave* from their own bank, hands it
to us with their phone and cédula, and `POST /api/v1/guest/bill/c2p` asks
Mercantil to pull the amount. That one difference — we initiate — is where all
the care goes.

The response is an outcome, and **all four must be handled**:

| Status | Meaning | What the client must do |
| --- | --- | --- |
| `SUCCEEDED` | settled | show the bill figures in `settlement` |
| `FAILED` | the bank said no | a retry with a fresh clave is safe |
| `IN_DOUBT` | the bank did **not** say | **never offer a retry** — the debit may have landed |
| `AMBIGUOUS` | a confirmed debit that could not be credited to the bill | staff resolve it, possibly a refund |

`IN_DOUBT` is the one that matters. Mercantil does not promise that
`invoice_number` deduplicates, so a charge whose outcome we never learned must
not be reported as declined — the diner would retry and pay twice for one
dinner. A timeout, a `408/425/429`, any `5xx`: all indeterminate, never a
rejection. The payment sits in `IN_DOUBT` and `bills.amountPaidVes` is untouched,
exactly as a PENDING claim is.

Staff resolve it. `POST /api/v1/payments/c2p/:id/resolve` asks Mercantil for its
movements and settles only when one matches on **both** the amount and the last
four digits of the payer's phone. Amount alone is a filter, never a decision:
two tables owing an identical total is the ordinary case in a restaurant, and
matching on amount would settle one table with the other's money. A movement it
cannot attribute moves the charge to `AMBIGUOUS` with the candidate references
attached, rather than guessing. `GET /api/v1/payments/c2p/unresolved` is the
queue that state implies — a charge that correctly refuses to guess is otherwise
indistinguishable from one that was lost. One bank movement settles exactly one
payment, enforced by the `(provider, provider_payment_id)` unique index.

**A matched charge the bill can no longer take is parked, not retried forever.**
Once the bank names a movement for a charge, `IN_DOUBT` has stopped being true —
we now know the money moved. If the bill closed or was voided while the charge
sat in the queue, `applyToBill` refuses it, and the charge goes to `AMBIGUOUS`
with the reference recorded, exactly as a confirmed debit does on the charge
path. It is the same money in the same position, so it gets the same answer: a
person decides, usually a refund. Leaving it `IN_DOUBT` meant every later
resolve re-ran the same query, matched the same movement and failed the same
way, so it never reached anybody while the diner stayed debited — and because
the attempt row rolled back with it, the queue showed a charge that looked as
though it had never been tried.

Parking is deliberately narrow, and by allowlist rather than by "did it throw".
A settlement credits the bill and — when the payment names a share — that share
too, so it can be refused from either side: `BILL_NOT_FOUND`, `BILL_NOT_OPEN`,
`PAYMENT_EXCEEDS_BALANCE` from the bill, and `SPLIT_STALE`, `SPLIT_NOT_ACTIVE`,
`SPLIT_SHARE_OVERPAID`, `SPLIT_SHARE_NOT_FOUND` from the share. All of them are
settled facts that asking again cannot change.

`AMBIGUOUS` is a state only a person leaves, so everything else keeps the charge
`IN_DOUBT` and retryable. A statement timeout or a dropped connection says
nothing about the bill. A reference conflict says nothing either: it means the
movement was claimed by another payment between our search and our commit, so it
was never ours.

**Past six hours, resolution stops answering the question.** The bank is asked
for movements from at most `RESOLUTION_WINDOW_MAX_MS` ago, so once a charge is
older than that the window no longer contains the moment it happened — and both
conclusions turn unsafe at the same time. An empty answer is not "the debit
never landed", because we asked about the wrong hours; and a *matching* movement
at that remove is more likely the same payer paying the same amount again, which
would settle an old charge with new money. So the charge leaves automated
resolution for `AMBIGUOUS` with `safeToRetry: false`, without a bank call being
spent on it. It was previously marked `FAILED` and reported as safe to retry —
an invitation to charge a diner twice, aimed at exactly the charges the
reconciler surfaces, since that job reports C2P charges unresolved beyond six
hours.

The unresolved queue also reads **PENDING** charges older than the settlement
window. PENDING is what a charge is while the bank is being called — normal for
seconds, impossible for hours — so an old one is a charge whose outcome was
never recorded, and it is the only kind nothing else would show. That matters
because the in-doubt transition is now attempted rather than depended upon: if
the database refuses it, the failure is logged and the caller still hears
`IN_DOUBT`. Throwing would reach the route, which aborts the idempotency key,
releasing the client to raise a second charge for a debit that may already have
landed — the double charge caused by our own bookkeeping rather than by the
bank.

The charge is idempotency-keyed and rate limited to 8 per 5 minutes per session,
because each attempt burns a clave the diner had to fetch and consumes the
restaurant's quota with Mercantil. The clave is validated for shape, used once,
and never stored — there is no column for it, and it is redacted out of every
diagnostic.

`GET /api/v1/guest/c2p/banks` returns, per bank, how to obtain a clave — the
channels it offers, the SMS short code and body, and how long the clave lives.
That last field is load-bearing: most banks give six hours, but Banplus gives
five minutes and 100% Banco ties the clave to the amount, so those must be
fetched at payment time, not when the diner sits down. The step Splite does not
control is the diner asking their own bank, and a generic "ask for a clave" is
what strands them.

The `invoice_number` is a formal, server-owned id — `SPL-<REST8>-<PAY32>`, the
restaurant's short id and the payment's full id — built from values we control,
never read from the request, and registered before Mercantil is called. Its
shape is enforced by a CHECK (migration 021), so every invoice reads back to its
restaurant and its payment. A C2P charge may also carry a `splitParticipantId`
to settle one share of a persistent split (see [Splitting a bill](#splitting-a-bill)).

One caveat, stated plainly: the Mercantil **wire format** — field names, paths,
and whether amounts cross as bolívares or céntimos — is taken from their
playground and **not yet confirmed against a live integration**. It is isolated
in `toMinorUnits`/`toBankAmount` with a round-trip test, so correcting the amount
convention is a one-function change, but it must be confirmed before the first
real charge.

### Provider webhooks

`POST /api/v1/webhooks/:provider`, its own router at its own path. Mounting the
payments router under a second prefix to also serve webhooks makes every payment
route answer there too, and middleware attached by prefix is then skipped by
changing the URL — an authorisation bypass dressed as a convenience.

There is no session; the signature is the credential. `X-Splite-Signature` is
HMAC-SHA256 over `{timestamp}.{rawBody}`, with `X-Splite-Timestamp` in unix
seconds. Three details are load-bearing:

- It signs the **raw bytes**. `req.rawBody` is captured by the `express.json`
  verify hook for exactly this. Signing a re-serialised `req.body` compares an
  HMAC of our JSON formatting against one of theirs, and those differ over key
  order and whitespace.
- The timestamp is **inside** the MAC. Beside it, an attacker replays a captured
  signature with a fresh timestamp and the window buys nothing.
- The **amount comes from our record, never the body.** A valid signature proves
  who sent the delivery and nothing more; settling whatever figure it names lets
  a compromised provider key rewrite a bill.

**202 means "stop sending this"**: settled, a duplicate of something settled, or
a body that never named a payment and never will however often it is resent.
Providers retry on any non-2xx and on timeouts where we did succeed, so
answering a duplicate with an error teaches one to retry forever.

It deliberately does *not* cover a delivery we merely failed to process. A
callback can overtake the commit of our own PENDING payment row — that gap is
milliseconds and providers are fast — and answering 202 there loses a real
settlement permanently: the money has moved and the bill never closes. Those
answer **503 `WEBHOOK_PAYMENT_UNRESOLVED`** with `Retry-After`, as do database
failures.

Duplicate detection is a primary key on `webhook_events_processed (provider,
provider_event_id)`, written **inside the settling transaction** so the two
cannot come apart: no ordering leaves money moved and the event unrecorded, or
the reverse. A concurrent duplicate blocks on that key, then rolls back having
settled nothing. A *failed* attempt claims nothing at all — a claim that
outlived its failure would block the retry meant to fix it, which is the trap in
claim-first idempotency.

The Redis entry the signature middleware sets is not that guarantee. It is keyed
on the signature and lives twice the timestamp tolerance, and providers re-sign
every retry, so it only ever catches byte-identical replays inside ten minutes
while retry budgets run for days. It stays because it is cheap and it stops a
captured request being replayed verbatim.

Send an `eventId`. Without one the only protection left is the payment status
check, which cannot tell two events for the same payment apart.

Every delivery is recorded in `webhook_deliveries`, rejected ones included:
repeated signature failures are how a leaked or rotated secret announces itself,
and a body we threw away cannot be investigated.

A delivery may only settle a payment recorded against **that same provider**.
Without the check, `PENDING` was all that was being tested — and a Pago Móvil
claim is `PENDING` with no provider at all, so a webhook naming its id settled
it, silently performing the verification a member of staff exists to perform.

Only the `SPLITE` provider exists today. A real acquirer is an entry in
`PROVIDERS`, not an edit to anything around it.

`WEBHOOK_SECRET` is one secret shared by every restaurant, which is a real limit
rather than an oversight: whoever holds it can name any tenant's pending
payment. The blast radius is bounded — the amount comes from our record, the
payment must exist, be `PENDING`, and belong to the provider that signed — but
rotation is all-or-nothing. Per-restaurant credentials are the fix and they wait
on the acquirer, since there is nothing yet to hold credentials *for*. **Card payments are not built
yet** — that needs an acquirer, and with one there is no matching problem at
all: the acquirer answers authoritatively, so none of the reconciliation
machinery above applies.

## Tips

A tip rides on a payment and **never touches the bill**. `payments.tip_ves` sits
beside `amount_ves`, and the bill's own columns — `total_due_ves`,
`amount_paid_ves` — are untouched by it. That is not tidiness; putting a tip on
the bill breaks three things at once:

- `CHECK (amount_paid_ves <= total_due_ves)` would reject it, because a diner
  who tips has handed over more than the bill asks for. That constraint is what
  makes overpayment impossible, and it must not be relaxed for this.
- A bill CLOSES on **exact equality** with its total. A tip inside
  `amount_paid_ves` would close a bill early or never, depending on which side
  of the total it landed on.
- `payment_ledger_drift` proves the cached balance against `SUM(amount_ves)`. A
  tip inside that sum reads as permanent drift on every tipped bill.

So `amount_ves` stays exactly what it always was — the part of the bill this
payment settles — and the tip sits next to it. What the payer actually handed
over is `amount_ves + tip_ves`, and that sum is what a bank is charged and what
a till receives. Nothing else in the schema has to know.

It is optional on all three diner-facing rails, defaulting to zero:

| Path | Field | What the money does |
| --- | --- | --- |
| `POST /api/v1/bills/{id}/payments` | `tipMinorUnits` | recorded on the payment; the bill advances by `amountMinorUnits` alone |
| `POST /api/v1/guest/bill/payment-claims` | `tipVes` | staff verify `amountVes + tipVes` against the bank app as one figure |
| `POST /api/v1/guest/bill/c2p` | `tipVes` | **Mercantil is asked to pull `amountVes + tipVes`**; only `amountVes` is credited to the bill |

The C2P row is the one to read twice. The diner's bank sees the single figure
they authorised, the bill sees only its own share, and the two are different
numbers on purpose — and that carries into resolution: an in-doubt charge is
matched against `amount + tip`, because that is the debit the bank actually
holds a movement for. Matching a tipped charge on the share alone finds nothing,
and "nothing" on that path means a charge written off while the diner stands
debited.

Responses report both halves rather than one merged figure: a payment result
carries `tipVes` and `totalChargedVes`, and a claim carries `tipVes` and
`totalPaidVes`. Staff reconciling against a bank statement need the sum; the
ledger needs the share.

**A recorded tip is immutable.** `payments_guard_transition` refuses to let
`tip_ves` move, exactly as it already refuses `amount_ves` — a tip a restaurant
could quietly reduce after the diner has gone is not a tip. Correcting one is a
refund and a new payment, not an edit.

There are no suggested percentages in the API. What to offer a diner — 10, 15,
20 — is a screen decision that changes per restaurant and per campaign, and
storing it here would make every change a deploy. Clients send an amount.

### Reading tips back

`GET /api/v1/payments/tips?from=…&to=…` answers the only question anybody asks
of them: how much came in over this shift, and how did it arrive.

```json
{
  "from": "2026-08-19T16:00:00.000Z",
  "to": "2026-08-20T04:00:00.000Z",
  "currency": "VES",
  "totalTipsVes": "16400",
  "inTillVes": "3000",
  "owedToStaffVes": "13000",
  "unclassifiedVes": "400",
  "byMethod": [
    { "paymentMethod": "C2P", "payments": 4, "tipsVes": "12000" },
    { "paymentMethod": "CASH", "payments": 2, "tipsVes": "3000" },
    { "paymentMethod": "SPLITE", "payments": 1, "tipsVes": "400" }
  ]
}
```

The split between `inTillVes` and `owedToStaffVes` is the point. A cash tip is
physically in the drawer and the restaurant is only deciding how to divide it;
an electronic tip landed in the restaurant's *bank account* and is a debt to
staff until it is paid out. One number for both would describe two different
situations identically.

**Which bucket a tip lands in comes from `payment_method`**, so the till
endpoint accepts an optional `paymentMethod` (`CASH`, `CARD`, `TRANSFER`,
`SPLITE`, `OTHER`) alongside the amount. Send it whenever a tip is involved.
Without it the payment records the default `SPLITE`, and the tip is reported as
`unclassifiedVes` — deliberately its own figure rather than folded into either
of the others, because calling it cash cancels a real debt to staff and calling
it electronic pays out money already in the drawer. The three always sum to
`totalTipsVes`. `C2P` and `PAGO_MOVIL` are not accepted from a client: those are
set by the rails that own them, and naming one here would be claiming a bank
movement nobody verified.

The period is read from **when the payment was taken**, not when it was
confirmed. A Pago Móvil claim declared at 23:50 and confirmed at 00:10 belongs
to the shift it was declared in and appears there once it is confirmed — so a
report run at midnight sharp will not yet show it. Re-run the report after the
queue is worked, which is the same rule as counting a till.

Only **SUCCEEDED** payments count. A tip on a PENDING Pago Móvil claim is money
a diner *says* they sent, and counting it would have a restaurant hand out cash
against a transfer nobody has verified; `IN_DOUBT` and `AMBIGUOUS` are excluded
more sharply still, being charges we cannot yet prove landed at all.

The window is **half-open** — `from` inclusive, `to` exclusive — so two
consecutive shifts tile without both claiming a payment on the seam. Both bounds
are required: a report whose period was guessed is a number somebody hands out
money against.

Nothing is cached. The per-bill figure is a `SUM` over the ledger rather than a
counter on `bills`, because a second counter is one more thing that can fall out
of step with the money — which is precisely what `payment_ledger_drift` exists
to catch.

## Splitting a bill

`POST /api/v1/bills/{id}/split/preview` — and the guest equivalent at
`/api/v1/guest/bill/split/preview` — computes who owes what. It is **advisory
and mutates nothing**: it computes and returns, and payment goes through the
payments endpoint, which holds the row lock and enforces the ceiling. To store a
plan a group settles against, see [Persisting the split](#persisting-the-split)
below — the preview and the persisted split compute the same allocation through
the same engine, so they are never different numbers.

| Mode | Behaviour |
|------|-----------|
| `FULL` | one participant owes the balance |
| `EQUAL` | divided evenly, largest remainder |
| `ITEMS` | participants claim lines; a shared line splits between its claimants |
| `CUSTOM` | the client states amounts, which must add up exactly |

**Every mode divides the same figure** — the outstanding VES balance, echoed
back as `outstandingVes`. Two bases would mean a client had to know which figure
each mode picked, which is the arithmetic this endpoint exists to remove from
the frontend.

Exactness is structural: every mode routes through the largest-remainder
allocator, whose parts sum to the total by construction, and the engine then
asserts it and raises rather than return a quietly wrong bill.
`totalAllocatedVes` is returned so a client can assert the same thing instead of
trusting it.

`ITEMS` allocates in two stages, both largest-remainder — the balance across the
lines by subtotal, then each line's result across whoever claimed it. Every line
must be claimed, because an unclaimed line is money owed by nobody and the parts
could not sum. `CUSTOM` refuses amounts that do not add up rather than rounding
them into shape, which would hide a client bug behind a number that looks right.

There is one *preview* endpoint, not two. An earlier
`GET /bills/{id}/split?diners=n` answered a strictly narrower version of the same
question and was removed rather than left alongside this one, because two
endpoints that nearly agree are a choice a client should not have to make.

### Persisting the split

Preview computes and forgets. `POST /api/v1/bills/{id}/splits` — and the guest
equivalent `POST /api/v1/guest/bill/splits` — computes the same allocation
through the same engine and **stores** it, so a table agrees a plan once and
settles it from several phones. Two things become impossible that the preview
alone allowed: a group could not persist a plan across their devices, and one
diner could pay past their share and leave another unable to pay theirs, because
at the bill level the money was fine.

The stored split is a `bill_splits` row with a `bill_split_participants` share
per diner and, for `ITEMS`, the whole-line claims in `bill_split_items`. Both of
its invariants are the **database's**, not the service's (migration 020), so an
API path that forgot the rule still cannot break it:

- The shares sum to the split's basis — the outstanding balance the moment it was
  agreed — checked by a deferred constraint trigger at commit, whole.
- A share is never overpaid: `CHECK (amount_paid_ves <= amount_ves)`, the exact
  analogue of the bill-level ceiling one level down.

The share is frozen once agreed; only its paid figure moves. A partial unique
index allows one `ACTIVE` split per bill — a group that changes its mind voids
the current one (`POST /api/v1/bills/{id}/splits/{splitId}/void`, refused once a
share has been paid into) and agrees another. `GET .../splits/active` reads the
live one.

Voiding takes the participant rows' locks rather than just summing them.
`advanceShare` locks the participant row and reads the split's status through a
join without locking the split, so an unlocked `SUM` could read zero while a
share payment committed beside it — leaving a VOID split with money credited to
one of its shares. **Settled money is also not the only money:** a declared Pago
Móvil or an in-doubt C2P charge names a share and has not credited it yet, and
voiding out from under one strands it. Those are refused too, naming how many
are in flight, because rejecting or resolving them first is a real step for
staff rather than something the system can decide.

A split can only be agreed on an **OPEN** bill, checked in `createSplit` rather
than in each route — the same reasoning that puts the payment rules inside
`applyToBill`. A split of a voided bill is a plan nobody can settle: the shares
compute perfectly against its outstanding balance, the table can read them off a
screen and agree to them, and then every payment is refused by `applyToBill`,
one diner at a time, at the till, long after the group thought the question was
closed. A settled bill was already refused, but incidentally — nothing
outstanding, so the *basis* failed and the bill's state was never consulted;
that is the right answer from an argument that stops holding the moment a status
other than OPEN can carry a balance.

The void is **scoped to the bill in the path**, not only to the tenant. That URL
states a containment relationship, and it has to be enforced rather than
implied: a split that is not on that bill reads as 404, the same answer a split
from another restaurant gets. Without the check, any of a restaurant's own bill
ids voided any of its splits — crossed ids in a client voided the wrong table's
plan, the response came back naming a bill the caller had never asked about,
and, since voiding is what releases the one-`ACTIVE`-per-bill index, a group
still settling against that plan could have a second one created underneath
them.

A payment settles a share by naming `splitParticipantId` — on the staff payment,
a Pago Móvil claim, or a C2P charge. Whichever rail it is, the share is credited
in the same transaction that moves the money, at the one point every settlement
passes through (`src/services/payments.js`), scoped to the bill it settled: a
payment cannot credit a share on another bill, or one whose split was voided. The
participant row is locked `FOR UPDATE`, so two diners racing the same share
serialise and the second is rejected on its ceiling rather than both crediting.

**A split stops governing a bill that changed underneath it.** The basis is
frozen so the plan does not move as it is paid — but the bill itself can move,
and in a dining room it routinely does: the table agrees to split, then orders
another round. Adding or removing a line marks any live split `STALE`, and a
stale split takes no further payment (409 `SPLIT_STALE`). Without that, the split
went on claiming the old total, both diners paid their share in full, and the
bill sat OPEN with the difference owed by nobody — everyone believing they were
square and the table unable to be cleared.

Stale rather than recomputed, because silently rewriting what a group agreed to
is worse than telling them it changed, and a share somebody has already paid
cannot move anyway. Money already paid in stays exactly where it was — it is on
the bill's ledger regardless — and the group agrees a fresh split on what is
actually left, which the one-active-per-bill index now permits. An edit that
leaves the total unchanged leaves the agreement standing: staleness is about the
figure, not about the fact of an edit.

`GET .../splits/active` returns the ACTIVE split, or the most recent STALE one —
so a client can tell "the bill changed, agree a new split" from "this table never
agreed one", which are otherwise the same empty result. Branch on `status`.

The split is a plan for who pays which part; it is **not** a second record of how
much the bill has been paid. That stays `bills.amountPaidVes`, so cash at the
till still settles the bill outside any split and the bill-level ceiling still
governs it. Participant labels are client-owned and anonymous — a share is a part
of a bill, not a Splite account.

## Table QR codes

`npm run qr` mints a code for every active table and writes a printable sheet:

```
QR_URL=https://your-api QR_EMAIL=you@example.com QR_PASSWORD='…' \
QR_APP_URL=https://your-frontend npm run qr
```

Each code encodes `<QR_APP_URL><QR_APP_PATH>?qr=<token>` — a **frontend** URL,
not an API one. Scanning it opens the guest app, which exchanges the token at
`POST /api/v1/guest/sessions` and renders that table's bill. `QR_APP_PATH`
defaults to `/t` and should match whatever route the frontend actually serves;
it is inside the printed code, so confirm it before printing.

The token is signed, not secret — it names its restaurant and table in plain
base64url, and is useful only because the signature cannot be forged. The
`nonce` inside it is checked against `tables.qr_nonce` on every scan.

**A QR does not expire.** It is printed onto furniture, so a clock is the wrong
control: revocation is rotating that table's nonce, which invalidates every
code already printed for it, immediately.

```
POST /api/v1/guest/tables/{tableId}/qr/rotate
```

Set `QR_TTL_SECONDS` only for codes that *should* expire — one printed on a
receipt rather than stuck to a table. The value is baked into each token when it
is minted, so changing it later does not affect codes already printed.

Minting goes through the API rather than the database so that it stays
restricted to OWNER and MANAGER, stays tenant-scoped, and leaves a `QR_ISSUED`
audit entry.

## Guest access

A diner scans a table QR, exchanges it for a session, and reads their bill:

```
POST   /api/v1/guest/sessions            exchange a signed QR for a session
GET    /api/v1/guest/bill                the open bill for that table
POST   /api/v1/guest/bill/split/preview  split it
DELETE /api/v1/guest/sessions            end the session
```

**No guest route takes a resource id.** The table comes from the session, which
came from a signed QR whose nonce is checked against the table row, so a guest
cannot ask for a bill that is not theirs — there is no identifier to tamper
with. Rotating a table's nonce invalidates every code already printed for it.

The session is a bearer token held in Redis, and only its SHA-256 is stored, so
a dump of Redis yields nothing usable. Guests see a deliberately narrower view
than staff: `dto.guestBill` withholds `restaurantId`, `calculationVersion` and
the rate provenance, and publishes the rate itself so a client can show an
approximate menu-currency figure.

## Money model

Settlement is **always VES**, in céntimos, stored as `BIGINT`. A menu may be
priced in VES, USD or EUR, but those are what the prices were *quoted* in —
never what is charged. `bills.currency` carries the menu currency and
`total_due_ves`/`amount_paid_ves` carry settlement (migration 008); migration
003 had briefly constrained `currency` itself to VES, when USD and USDT were
being applied at face value against a bolívar balance.

The exchange rate is **frozen when the bill is opened** and reused for every
later split, so the total a diner is quoted cannot move while they eat.
`total_due_ves`/`amount_paid_ves` are the authoritative settlement pair; the
menu-currency figure is display. An FX outage can stop a *foreign-currency bill
being opened* (503, fail closed), but it can never reach a payment — payments
use the rate already frozen on the bill and make no FX call at all.

Splits use largest-remainder allocation (`src/services/split.js`) so the parts
sum to exactly the total. Rounding each share independently would leave the last
diner unable to pay under `CHECK (amount_paid_ves <= total_due_ves)`, or leave
the bill permanently a few céntimos short of closing.

## Exchange rate

`GET /api/v1/exchange-rate` returns the official reference rates published by
the [Banco Central de Venezuela](https://www.bcv.org.ve/):

```json
{
  "rates": {
    "USD": { "rate": "757.54060000", "valueDate": "2026-08-10", "source": "BCV" },
    "EUR": { "rate": "875.21695680", "valueDate": "2026-08-10", "source": "BCV" }
  }
}
```

BCV publishes no API, so each rate is parsed from its own block on their home
page — `id="dolar"` and `id="euro"` (`src/connectors/bcv.js`) — in a single
request, and cached for 15 minutes. Their own
`cache-control` is 5 minutes and the figure changes at most once per business
day. Policy lives separately in `src/services/fx.js`, which is the single place
that decides whether a rate is usable.

`valueDate` is **the date the rate applies to, not when it was fetched**. BCV
posts the figure that takes effect on the next business day, so the page can be
read at any hour — a rate read on a Saturday normally carries Monday's date. Do
not key anything on "today".

**A deployment less than a day old may have no rate at all.** BCV publishes
after ~16:30 Caracas for the next business day, so a service started that
evening sees a rate that is not yet in force and has no history to fall back
on: `/api/v1/exchange-rate` answers 503 and a foreign-currency bill cannot be
opened until midnight Caracas. Nothing is wrong, and nothing needs doing —
the newly published rate is persisted as it arrives, and comes into force on
its own. VES-priced bills are unaffected throughout.

There is **no fallback rate anywhere**. A rate is rejected if it falls outside
`FX_MIN_RATE`/`FX_MAX_RATE` or moves more than `FX_MAX_DEVIATION_PCT` from the
last known good value, and a failure returns null rather than a stale or
invented number. The endpoint answers **503** in that case; payments are
unaffected either way.

`fx_rates` keeps the rate history and doubles as the deviation baseline, so a
restart does not lose the last known good value.

> **TLS note.** `bcv.org.ve` serves an incomplete certificate chain — it presents
> the wrong Sectigo intermediate, so the leaf cannot be verified against Node's
> root store alone. `curl` and `openssl` mask this by fetching the missing
> certificate themselves; Node does not. The correct intermediate is committed at
> `certs/sectigo-public-server-auth-dv-r36.pem` and added to the trust list for
> that request. Certificate verification is **never disabled**. That file is
> deliberately exempted from the `*.pem` rule in `.gitignore`, and the image
> copies it in; without it the lookup fails at runtime.

## Migrations

Migrations live in `/migrations` and are applied in filename order by
`npm run migrate`, each in its own transaction, guarded by a Postgres advisory
lock so concurrent deploys cannot race.

`002_phase1_hardening.sql` adds a **globally unique staff email** index.
Deduplicate `users.email` across restaurants before applying it to a database
that already holds data.

`003_ves_settlement.sql` constrains bills to VES and adds the locked-rate
columns. It rewrites any non-VES bill currency to `VES`, so check that no live
bill is mid-payment when you apply it.

## Process lifecycle

An unhandled rejection and an uncaught exception are both **fatal**: log at
`fatal`, drain, exit non-zero, let the orchestrator start a clean process.

Registering a listener for `unhandledRejection` overrides Node's own default,
which since v15 is to throw and terminate. A listener that only logged did not
merely fail to act — it disabled the runtime's crash behaviour and left the
process running on state nobody had reasoned about. For this service that
matters: a rejection can surface after a bill's row lock is taken but before the
transaction resolves, or between applying a payment and storing its idempotency
response. Continuing means serving further payments from a process whose
in-flight guarantees are already unknown.

**Exit codes are load-bearing.** A signal exits `0` because stopping was
intentional; anything fatal exits `1`. Exiting `0` after a crash reads as a
clean stop, so `restart: on-failure` would leave the service down and
Kubernetes would not record a failure. A forced exit after the drain timeout is
also `1` — something refused to let go.

**Readiness fails immediately** once a shutdown begins, so a load balancer stops
routing new requests while in-flight ones finish. Liveness deliberately keeps
answering `200`: failing it would have the orchestrator kill the process
outright instead of letting it drain.

## Database timeouts

Four settings that are often confused for one another:

| Setting | Bounds |
| --- | --- |
| `DB_CONNECTION_TIMEOUT_MS` | waiting to **obtain** a pooled connection |
| `DB_STATEMENT_TIMEOUT_MS` | how long **one statement** may run |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | a transaction that has stopped progressing |
| `DB_PAYMENT_STATEMENT_TIMEOUT_MS` | the payment path's own statement budget |

A connection timeout says nothing about query duration, so the first two are not
alternatives. `statement_timeout` is set server-side, so Postgres cancels the
query itself; a client-side `query_timeout` would only stop node-pg waiting
while the backend carried on holding locks.

`idle_in_transaction_session_timeout` matters here specifically because
`processSplitPayment` takes `SELECT ... FOR UPDATE` on a bill. A client that
stalls between `BEGIN` and `COMMIT` holds that lock, blocking every other diner
paying the same bill until the TCP connection dies.

**Payments get a larger budget deliberately.** Not because the queries are slow
— they are a locked read and two writes — but because *waiting for the lock
counts toward `statement_timeout`*. Several diners paying at once serialise, so
the last one in a busy split can spend most of its budget blocked rather than
working. `withTransaction(fn, { statementTimeoutMs })` applies it with
`SET LOCAL`, which reverts on commit so an enlarged budget cannot leak onto the
next caller to borrow that pooled connection.

One thing this deliberately does **not** try to solve: slow Venezuelan payment
rails. Bank confirmation latency is not database time, and the fix is to keep it
out of the transaction rather than to raise a SQL timeout to cover it.

That is a standing rule rather than an observation about payments:

> **No external network call while a transaction holds a business lock.**

Two places it applies today. A payment takes no exchange rate at all — the rate
is frozen when the bill is opened — so nothing external is reachable from it.
Opening a bill *may* fetch from BCV, so that happens before `BEGIN`; it once ran
after the table row was locked, which stalled every other request for that table,
held a pooled connection, and could leave the transaction idle long enough for
`idle_in_transaction_session_timeout` to terminate the session outright. Both
orderings are asserted by tests, so a future change cannot quietly undo either.

When a payment provider is wired up, its call belongs outside the transaction on
the same rule.

## Logging

Every log line is a JSON object on stdout, carrying the request context:

```json
{
  "level": 50,
  "time": "2026-08-10T18:22:31.004Z",
  "service": "splite-api",
  "requestId": "0f3c...",
  "restaurantId": "9a1e...",
  "userId": "44c2...",
  "event": "REQUEST_FAILED",
  "err": { "type": "Error", "message": "..." }
}
```

`requestId`, `restaurantId`, `userId` and `role` are held in an
`AsyncLocalStorage` context opened by the request-id middleware and filled in by
`authenticateToken`, then merged into every line by pino's `mixin`. A service
therefore logs without being handed a request object and without threading a
correlation id through call signatures that have no other use for it.

Levels: `50`/`error` is ours to fix, `40`/`warn` is usually the caller's, `30`
/`info` is the access record. An alert on `level >= 50` is meaningful because a
malformed request logs at 40, not 50. Health probes are not logged at all.

Secrets are redacted by path (`REDACT_PATHS` in `src/connectors/logger.js`).
That includes `rawHeaders`, which is a flat `[name, value, ...]` array and so
cannot be filtered by key, and `res.req` — a response exposes the request that
produced it, which is how the `Authorization` header reached the access log
before this was added.

Set `LOG_LEVEL` to override; the suite runs at `silent`.

### Reporting

These logs are for operating the service, not for reporting to restaurants.
Anything a restaurant should see — items ordered, prices, payments taken, how
many diners split a bill — belongs in the database, where `bills`, `bill_items`
and `audit_logs` are durable, queryable and already tenant-scoped. Logs are
sampled, expired and shipped off-box; they are the wrong system of record for a
number a restaurant might reconcile against.

What the structured events do give you is the operational half of that picture:
because every line carries `restaurantId` and a stable `event`, "which tenant is
seeing payment failures this week" is a query rather than a grep.

## Deploying to Railway

Three services in one project: this app, Postgres and Redis. `railway.json`
selects the Dockerfile, points the platform's health check at `/health/ready`,
and runs `npm run migrate` as a pre-deploy command so a release cannot serve
traffic against a schema it has not migrated. The runner takes an advisory lock
and records each file in `schema_migrations`, so concurrent deploys serialise and
re-running is a no-op.

1. Create the project and add **Postgres** and **Redis** from Railway's catalogue.
2. Deploy this repository as a third service. The Dockerfile is detected automatically.
3. Set the variables from `.env.production.example`. `DATABASE_URL` and `REDIS_URL`
   use Railway's reference syntax (`${{Postgres.DATABASE_URL}}`) so no credential is
   ever copied by hand.
4. Generate the four secrets with `npm run secrets` and paste them in. They are
   printed once and never written to disk.
5. Seed the first restaurant from the Railway shell, then delete the seed variables:

   ```
   ALLOW_PRODUCTION_SEED=true npm run seed
   ```

**`DB_SSL=false` is deliberate.** The app defaults it to true whenever
`NODE_ENV=production`, but Railway's private network (`postgres.railway.internal`)
carries no TLS, so the default fails to connect on first boot. If you switch to the
public proxy URL instead, set `DB_SSL=true` *and*
`DB_SSL_REJECT_UNAUTHORIZED=false` — the proxy presents a certificate for a
different hostname.

`TRUST_PROXY=1` matters more than it looks: Railway terminates TLS ahead of the
app, and rate limiting is keyed on `req.ip`. Leave it unset and every client
shares one bucket.

## Building a frontend

`docs/FRONTEND_BRIEF.md` is written to be handed to a frontend developer or
pasted into an AI builder. It states the conventions a client cannot infer from
the spec alone: that money is never a number, that `/auth/refresh` must not be
used to identify a user, that guest requests carry two headers, and that split
arithmetic belongs on the server.

## Generating a frontend client

`openapi.json` is committed at the repository root and CI fails if it drifts from
the code (`npm run openapi:check`), so a client can be generated from git without
the API running anywhere:

```
npx openapi-typescript openapi.json -o src/api.d.ts
```

Regenerate the artifact with `npm run openapi:dump` after changing any route or
schema. The live document is also served at `/openapi.json`, with Swagger UI at
`/docs` while `DOCS_ENABLED=true`.

## Production notes

1. Use `DATABASE_URL` with TLS. Set `DB_SSL_REJECT_UNAUTHORIZED=true` once you pin your provider's CA.
2. Keep PostgreSQL and Redis on private networking; do not publish their ports.
3. Set `CORS_ORIGINS` to your exact frontend origins. Wildcards are rejected in production.
4. Set `TRUST_PROXY` to the number of proxy hops in front of the API, otherwise `req.ip` — and with it rate limiting and audit records — is attacker-controlled.
5. Run `npm run migrate` as a controlled deployment step, not on process boot.
   On Railway that is `railway.json`'s `preDeployCommand`, which runs before the
   new version takes traffic; elsewhere it is a release command or a manual step.
6. Commit `package-lock.json`; the image build and CI both depend on it for reproducibility.

## Retention

Four tables grow forever and none is consulted after a point. `npm run purge`
clears them; `npm run purge -- --dry-run` counts without deleting. Nothing here
is urgent — a purge that misses a week deletes a week more the next time.

## Reconciliation

Two counters in this schema are caches of the ledger, maintained in the same
transaction that moves the money: `bills.amount_paid_ves`, and one level down
`bill_split_participants.amount_paid_ves`. Each has a view returning the rows
where the cache and the ledger disagree — `payment_ledger_drift` and
`bill_split_share_drift` — and both should always be empty.

`npm run reconcile` reads them and **exits non-zero when either is not**, so
whatever runs it raises the finding instead of logging into the void. Both views
existed before this and nothing read them, which is the same as not having them:
the discrepancy would then be found by an accountant, or by a diner arguing at a
till, which is the situation the ledger was built to make impossible.

It repairs nothing, deliberately. Drift means a write path is wrong, and quietly
correcting the symptom removes the only evidence of it — fix the cause, then
correct the rows on purpose and record why.

It also reports, as *attention* rather than failure, C2P charges left `IN_DOUBT`
or `AMBIGUOUS` beyond `RECONCILE_UNRESOLVED_C2P_HOURS` (6). Those are correct
states, not broken ones, but the diner has been debited and is waiting on a
person, so a queue that has stopped being worked should not stay silent.

## Scheduled maintenance

`npm run maintenance` runs the purge and then the reconciler, and exits with the
worse of the two — drift outranks a housekeeping failure, because one is money
not adding up and the other is disk.

Deploy it as a second Railway service from the same image, pointed at
`railway.maintenance.json` (Settings → Config-as-code path), which carries a
`cronSchedule` of `0 7 * * *` and `restartPolicyType: NEVER` so a failed run is
reported rather than retried in a loop. It needs the same `DATABASE_URL` as the
API and nothing else.

A command on a schedule rather than a timer inside the API process: the web
service is replicated, and N replicas each waking to delete the same rows or run
the same scan is work multiplied by N to no effect. The purge's advisory lock
makes concurrent runs safe, which is not the same as making them useful.

A command rather than a timer inside the API process: the web process is
replicated, and N replicas each waking to delete the same rows is work
multiplied by N to no effect. An advisory lock makes concurrent runs safe rather
than useful.

| Table | Kept | Because |
| --- | --- | --- |
| `idempotency_keys` | until `expires_at` | the endpoint treats a missing key as a first attempt |
| `refresh_sessions` | 14 days past expiry | an expired session authenticates nothing; the extra fortnight is so reuse detection has something to point at |
| `fx_rates` | 180 days | the rate fallback reads this when BCV is unreachable, so it must outlast an outage |
| `webhook_deliveries` | 90 days | read when a payment is disputed, which happens within a billing cycle or not at all |
| `webhook_events_processed` | 180 days | it is what stops a redelivered event settling a bill twice, so it must outlast provider retry budgets |

Retention is set by what still *reads* a row, not by what feels tidy. And the
purge can never empty a table something depends on being non-empty: **the newest
`fx_rates` row per currency is never deleted, whatever its age.** If FX has been
disabled or failing for longer than the retention window, every row is older
than it, and a plain age-based delete would empty the table and leave the
fallback with nothing — turning the purge into the outage the fallback exists to
prevent.

Deletes run in bounded batches. One statement removing a year of webhook
deliveries holds locks and bloats WAL for as long as it takes; a loop of small
deletes lets the table stay usable while it runs.

## Login throttling

Failed logins are counted **per account** as well as per address, since attempts
spread over many addresses at one account are not slowed by an address limiter
at all.

Worth being precise about what that buys, because it is easy to file under
"brute force handled" and stop looking. Passwords are created with a twelve
character minimum and every attempt costs an Argon2id verify at 19 MiB — a
thousand addresses at ten a minute never reaches a twelve-character space.
Guessing was never the exposure. What the counter buys is:

- **Cost.** `login()` hashes a decoy when the account does not exist, so that
  response timing cannot enumerate accounts. That means *every* attempt pays the
  full 19 MiB, including attempts against addresses never registered, and a
  distributed caller bypassed the per-address bound on that work. The counter is
  checked before the lookup and before the verify, which is where the saving is.
- **Visibility.** Failures were already audited; a counter is what turns rows in
  a table nobody reads into something that can raise an alarm.

Two properties matter more than the threshold.

**It must not become the attack.** If hammering an address locked the account
behind it, anyone who knows an owner's email — it is on the registration form
and on their receipts — could shut a restaurant out of its own till on a Friday
night. That is worse than what it prevents. So: no persistent lock, a fifteen
minute self-healing window, a threshold of 20, and the count cleared the moment
a real password succeeds. Nothing here ever needs a human to lift it.

**It must not enumerate.** The count is kept against the address that was
*submitted*, whether or not an account exists for it, and the response is the
same `RATE_LIMITED` the address limiter returns. If only real accounts could be
throttled, "this address can be throttled and that one cannot" would be exactly
the oracle the decoy hash exists to deny. The key is a SHA-256 of the address,
because Redis keys surface in logs and dashboards and this one is somebody's
email.

The correct password is refused too while the count stands. That is deliberate:
a throttle that let the right password through would not be a throttle, since
the right password is what the attacker is looking for.

**What none of this stops is credential stuffing** — one password per account,
known from someone else's breach, tried once. No threshold fires on a single
attempt. MFA and rejecting known-breached passwords at creation are the answers
to that, and both are unbuilt.

## Rate limiting

Three layers, and which one does the real work depends on whether the caller has
been identified yet.

| Where | Keys on | Why |
| --- | --- | --- |
| `/api/v1` | address | coarse backstop, mounted before any authentication |
| `POST /guest/sessions` | address | nothing else exists yet — this is where a credential is created |
| authenticated guest routes | guest session | mounted after `authenticateGuest` |
| `/api/v1/bills` | staff subject | mounted after `authenticateToken` |
| `/api/v1/auth` | address, **fail-closed** | the limiter is what stands between an attacker and a password |

The distinction that matters: **a credential identifies a caller, an address
identifies a network.** Diners are on phones behind carrier NAT, and diners on
the venue WiFi share one address outright, so a per-IP limit on the guest
surface throttles every table in the room at once — a busy Friday rather than an
abuser. The guest limit was 30 a minute for the whole restaurant; it is now 60 a
minute per session, with a generous address-level backstop behind it.

Only `/auth` fails closed. There the limiter is the brute-force protection
itself. Everywhere else it bounds volume, and refusing every diner in the
building because Redis blinked would be choosing an outage over a rate limit.

One trap worth knowing if you add another limiter here: the guest counter uses
the prefix `guest:rl`, **not** `guest:session`, because the latter is where the
sessions themselves are stored. Pointing a limiter at it makes the counter and
the credential the same Redis key — `INCR` on a key holding JSON errors, the
limiter reads that as its backend being unavailable and fails open, and the
limit silently never applies.

## Open points

Everything known to be incomplete, in rough priority order. Nothing here is a
surprise waiting to be found; it is the list of things deliberately not done
yet.

### Waiting on a decision

Beta. These are not unfinished code — they are questions whose answers change
what gets built, and they are parked deliberately rather than guessed at.

| Open question | What it blocks | What happens meanwhile |
| --- | --- | --- |
| **Which mail provider, and on what domain?** | All of onboarding. `MAIL_TRANSPORT=log` writes the message to the log and sends nothing, and is refused in production. | `ONBOARDING_ENABLED=false`, so the form is not served at all. Needs SPF and DKIM on a real domain too, or the mail reaches spam and the team never learns a restaurant applied. |
| **Which card acquirer?** | Card payments entirely, and paying inside the app. | Diners declare Pago Móvil and staff confirm. |
| **What does a lapsed trial lose?** | Nothing today — `plan_tier` and `trial_ends_at` are reported by `GET /api/v1/account` and enforced nowhere. | Clients can warn. The obvious answer is the wrong one: cutting off bills mid-service strands a dining room full of seated diners over an unpaid invoice. |
| **Should a failing RIF check digit be rejected?** | Nothing. The mod-11 result is recorded in `restaurant_signups.rif_checksum_ok` and shown to the reviewer. | Accepted either way. Turning away a real restaurant at the form is worse than storing one malformed tax id, and the column is the evidence for deciding later. Note `J-00000000-0` passes — the checksum catches transcription slips, not invention. |

Two smaller ones, same character:

- **No admin surface.** Inviting a lead is `npm run onboarding -- invite <id>`,
  not an endpoint, because every authenticated surface here is scoped to a
  restaurant the caller belongs to and there is no platform-operator role.
  Inventing one for a handful of approvals a week is a second authentication
  model to secure forever. If volume justifies a console, it calls the same
  functions the CLI does.
- **Staff are not told when a claim arrives.** They poll
  `GET /api/v1/payments/claims`. A diner declaring a payment nobody looks at is
  the failure mode to watch for in beta, and the fix — push, or a badge fed by
  polling — is a frontend decision.

### Blocking real use

- **The Mercantil C2P wire format is unconfirmed.** The in-app charge rail is
  built end to end — charge, in-doubt resolution, the clave guide, the invoice
  policy — and a guest *can* now pay from their own bank without leaving the app.
  What is not yet verified against a live integration is Mercantil's own request
  shape: field names, paths, and whether amounts cross as bolívares or céntimos.
  It is isolated in `toMinorUnits`/`toBankAmount` with a round-trip test, so the
  correction is one function, but it must be confirmed before the first real
  charge — sending céntimos where bolívares are expected is a debit a hundred
  times too large. Until then, C2P is code-complete but not switched on for real
  money. Declared Pago Móvil remains the money path that works today.
- **Onboarding is built but not switched on.** A public form records a lead and
  emails the team, who telephone the restaurant and then run
  `npm run onboarding -- invite <id>`. It is mounted only under
  `ONBOARDING_ENABLED`, which is off, because it cannot work without a mail
  provider — see [Waiting on a decision](#waiting-on-a-decision). The frontend
  page that consumes the invitation link, `/registro/verificar`, does not exist
  yet either.
- **No card payments.** A diner can declare a Pago Móvil, a signed webhook can
  settle a bill, and C2P (above) is Splite moving money on the diner's
  instruction — but a card, entered and charged in the app, needs an acquirer,
  which is the open decision below. With one there is no reconciliation problem
  at all: the acquirer answers authoritatively.
- **No automatic bank reconciliation.** Confirming a declared Pago Móvil is a
  person reading a bank app. Reading the feed and matching movements to tables
  is real work with a real trap: two tables with identical totals and a payment
  with no reference must produce an exception for staff, never a guess. Guessing
  closes the wrong bill *and* makes the other table pay twice, which is worse
  than not confirming at all.

### Port still outstanding

From the working copy, onto the current model:

- POS settlement: HMAC request signing, timestamp and nonce replay protection,
  and an external-reference idempotency key.
- Guest sessions bound to the current bill. The incoming version moves them from
  Redis into a `guest_sessions` table keyed on `bill_id`; that is a model change,
  not an addition, and has not been adopted. (Split shares are now persisted in
  their own tables — see [Splitting a bill](#splitting-a-bill) — rather than
  waiting on this.)
- Per-quantity item claims. `ITEMS` splits a whole line evenly between its
  claimants; assigning a subset of a line's quantity — two of three beers to Ana,
  one to Luis — is deliberately deferred, and would add a quantity column to
  `bill_split_items`.

### Phase 2, not started

- **A real provider adapter.** The webhook route is mounted and
  `src/middleware/webhookSignature.js` is finally wired to it, but the only
  provider defined is `SPLITE` — our own HMAC scheme. A Venezuelan rail is an
  entry in `PROVIDERS` supplying its own verifier and parser, and nothing else
  changes.
- **A real provider adapter**, still: `SPLITE` is our own HMAC scheme.
- **MFA is unstarted**, and it is the auth work that would actually matter. See
  [Login throttling](#login-throttling) for why the per-account counter added
  alongside it is not a substitute.
- **Nothing schedules the purge yet.** `npm run purge` exists and is tested;
  what is missing is a Railway cron entry calling it daily. Until then the
  tables it clears keep growing.

### Security and correctness

- **Access tokens cannot be revoked** within their 15-minute life — see below.
  The Redis refresh mirror that claimed to solve this has been removed: nothing
  read it, and nothing usefully could, since the access token carries no `jti`
  and the refresh path has to read Postgres anyway in order to rotate.
- **Access tokens cannot be revoked** within their 15-minute life. Acceptable at
  that TTL, but it means "revoke" only ever affects refresh tokens.
- **The app-level rate limiter still cannot key on a user**, being mounted ahead
  of authentication. It is now only a coarse backstop: the bills router and the
  guest router each apply their own limiter after authenticating, keyed on the
  staff subject and the guest session respectively.
- **`/health/ready` is an unauthenticated database round-trip**, deliberately
  ahead of the rate limiter so probes do not consume client budget. That also
  makes it free load for anyone who finds it.

### Tooling

- **`npm audit` cannot fail the build** (`continue-on-error: true`).
- **There is still no ESLint.** `lint` now pipes through `xargs -n 1 node --check`
  so a syntax error does fail the build — it previously used `find -exec`, which
  returns *find's* exit code and let an unparseable test file reach CI — but
  `node --check` only parses. No rule about unused variables, shadowing or
  accidental globals is enforced.
- **`scripts/` still uses `console.*`.** Only `src/` was converted to structured
  logging; the migrate and seed CLIs were left alone deliberately, but a deploy
  step arguably deserves structured output too.
- **Dead code:** `requireTenant`, `revokeAllSessionsForUser` and
  `registerSchema` are exported and never used.

### Numbers that are guesses

These are placeholders chosen without data, and should be set from observed
behaviour once there is traffic:

- `DB_PAYMENT_STATEMENT_TIMEOUT_MS=15000` — a guess at how much lock contention
  a busy split produces.
- `SHUTDOWN_TIMEOUT_MS` is hardcoded at 10s. If a payment rail is ever called
  inside a request handler, this must exceed the longest in-flight request or
  shutdown will sever payments mid-flight.
- `FX_MAX_DEVIATION_PCT=5` — rejects a rate that moves more than 5% from the
  last known good one. A genuine devaluation beyond that needs a human.

### Accepted, not fixed

- The old development secrets (`dev_jwt_secret`, `dev_webhook_secret`) remain in
  public git history. They were never deployed, so nothing was ever signed with
  them; rotating would not remove them from history, and rewriting history would
  break every clone. Any secret that touches a real deploy must be rotated in the
  hosting provider, not here.
