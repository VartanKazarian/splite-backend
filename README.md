# Splite Backend — Phase 1

Security foundation for Splite, a Venezuela-focused bill-splitting API.

## What Phase 1 covers

- Express API with hardened headers, strict CORS and per-request correlation ids
- PostgreSQL schema managed through versioned, transactional migrations
- Multi-tenant restaurant / user / table / bill model, tenant-scoped on every query
- Argon2id password hashing with constant-time failure paths
- Short-lived access JWTs plus rotating refresh sessions with reuse detection
- Redis-backed session mirror and rate limiting (fail-closed on the auth surface)
- RBAC: `OWNER`, `MANAGER`, `CASHIER`, `WAITER`
- Signed, expiring, rotatable QR tokens; hashed guest session tokens
- VES-only settlement with exact BigInt arithmetic and largest-remainder splits
- Menus priced in VES, USD or EUR; the settlement rate frozen when the bill opens, never guessed
- Payment concurrency control via `SELECT ... FOR UPDATE`
- Idempotency keys on money-moving endpoints
- Audit logging with actor, tenant, IP and request id
- Multi-stage Docker image running as a non-root user; hardened Compose stack
- CI: syntax check, unit tests, dependency audit, invisible-character guard, image build

## Local development

```bash
cp .env.example .env
npm install
docker compose up -d db redis
npm run migrate
npm run seed
npm test
npm start
```

Generate real secrets before deploying anywhere:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The app refuses to start in production with missing, short, duplicated or
placeholder secrets.

## API

The API is described by an **OpenAPI 3.1 document**, which is the contract:

| | |
| --- | --- |
| `GET /openapi.json` | the machine-readable document |
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

Set `DOCS_ENABLED=false` to withhold both endpoints and distribute
`openapi.json` out of band instead.

Monetary amounts cross the wire as **strings**, because a JSON number has
already lost precision past 2^53 by the time it arrives. Payments accept an
`Idempotency-Key` header (or `idempotencyKey` in the body); replaying a
completed key returns the stored response instead of charging twice.

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

## Production notes

1. Use `DATABASE_URL` with TLS. Set `DB_SSL_REJECT_UNAUTHORIZED=true` once you pin your provider's CA.
2. Keep PostgreSQL and Redis on private networking; do not publish their ports.
3. Set `CORS_ORIGINS` to your exact frontend origins. Wildcards are rejected in production.
4. Set `TRUST_PROXY` to the number of proxy hops in front of the API, otherwise `req.ip` — and with it rate limiting and audit records — is attacker-controlled.
5. Run `npm run migrate` as a controlled deployment step, not on process boot.
6. Commit `package-lock.json`; the image build and CI both depend on it for reproducibility.

## Open points

Everything known to be incomplete, in rough priority order. Nothing here is a
surprise waiting to be found; it is the list of things deliberately not done
yet.

### Blocking real use

- **No payments ledger.** `bills.amount_paid` is an aggregate counter. There is
  no `payments` table, so there is no record of who paid what, when, under which
  idempotency key, or against which provider reference — and therefore no
  reconciliation, refunds, or dispute trail. A provider webhook has nothing to
  map an external payment id onto, so this blocks the webhook work below.
- **No bill line items.** A bill carries a total and nothing else, so a
  restaurant cannot be told what was ordered. This is also the prerequisite for
  any reporting.
- **No onboarding.** Restaurants and their first owner are created by
  `npm run seed`. Whether signup is self-service or invite-only is an open
  product decision.

### Port still outstanding

From the working copy, onto the current model:

- Bill line items. The ground under them is done — migration 008 moved
  settlement onto `total_due_ves`/`amount_paid_ves`, made `bills.currency` the
  menu currency (VES/USD/EUR), and snapshots the rate when the bill opens —
  so `bill_items` with immutable price snapshots is the next PR.
- Service charge, VAT and tip, rebuilt on `services/money.js` rather than the
  incoming `Number`/`Math.round` arithmetic.
- The split engine (FULL, ITEMS, EQUAL, CUSTOM) with participant claim tokens.
- POS settlement: HMAC request signing, timestamp and nonce replay protection,
  and an external-reference idempotency key.
- Guest sessions bound to the current bill. The incoming version moves them from
  Redis into a `guest_sessions` table keyed on `bill_id`; that is a model change,
  not an addition, and has not been adopted.

### Phase 2, not started

- **Webhook route wiring.** `src/middleware/webhookSignature.js` is complete —
  HMAC over the raw body, a two-sided timestamp window, Redis-backed replay
  protection that fails closed — but it is not mounted on any route. It needs the
  payments ledger first, so a callback has something to reconcile against.
- **Guest-facing bill read.** `authenticateGuest` exists in
  `services/guest.js` and is never mounted. Guests can obtain a session from a
  table QR but cannot yet read the bill it belongs to.
- **Staff account lockout.** The rate limiter is per-IP, not per-account, so
  distributed attempts against one account are not slowed. MFA for staff logins
  is also unstarted.
- **Scheduled purges.** `idempotency_keys` has a `purgeExpired()` that nothing
  calls; `refresh_sessions` and `fx_rates` accumulate revoked and superseded rows
  indefinitely. All three need a scheduled job.

### Security and correctness

- **The Redis refresh mirror is write-only.** `services/auth.js` writes
  `refresh:<jti>` on login and deletes it on revocation, but nothing ever reads
  it. The comment claims it makes revocation immediate without a database read;
  it delivers none of that. Either wire it into verification or delete it.
- **Reuse detection does not clear the mirrors it revokes.** The bulk revoke in
  `refresh()` skips the Redis keys, unlike `revokeAllSessionsForUser`. Harmless
  only while the mirror is unread.
- **Access tokens cannot be revoked** within their 15-minute life. Acceptable at
  that TTL, but it means "revoke" only ever affects refresh tokens.
- **The app-level rate limiter cannot key on a user.** It is mounted before any
  authentication, so `req.user?.sub` is always undefined and the bucket is
  per-IP. Behind carrier NAT that is one bucket for many people. The bills router
  works around this with its own limiter mounted after auth.
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
