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
- Staff administration by rank, with a restaurant that cannot lose its last owner
- Optional TOTP second factor with sealed secrets and single-use recovery codes
- Signed, expiring, rotatable QR tokens; hashed guest session tokens
- Guest bill access scoped to the scanned table, naming no resource ids
- Audit logging with actor, tenant, IP and request id

**Money**

- VES-only settlement with exact BigInt arithmetic and largest-remainder splits
- Menus priced in VES, USD or EUR, at the BCV rate in force, never guessed
- Menus built from a photo or PDF by a vision model, with staff confirming every
  row before anything is written
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
- Node 22; CI: ESLint, OpenAPI drift check, unit tests, integration tests
  against real Postgres and Redis, a blocking audit of production dependencies,
  invisible-character guard, image build

Restaurants arrive through a reviewed registration form rather than a seed
script — see [Registering a restaurant](#registering-a-restaurant).

Bills settle from four directions — the till, a diner's declared Pago Móvil, a
Mercantil C2P charge, and a signed provider webhook — all through one settlement
function. See [Getting paid](#getting-paid). **Card payments are not built**:
that needs an acquirer.

Not yet built: card payments, and automatic bank reconciliation. See
[Open points](#open-points).

Several features are **off until a deployment configures them** — see
[What has to be configured](#what-has-to-be-configured) for the whole list in
one place, and for what each one does when it is not.

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

`npm run lint` is ESLint over every JavaScript file in the repository, on
`@eslint/js` recommended plus the rules that catch what the previous
`node --check` could not: unused variables, shadowed bindings, and assignments
to undeclared names. Shadowing is the one that earns its place here — money
moves through nested scopes, and an inner binding that masks an outer one is how
the wrong figure gets written while every line still reads correctly.

`npm run audit` is the blocking half of CI's dependency check:
`npm audit --omit=dev --audit-level=high`, over the dependencies that actually
reach production, since the image is built with `npm ci --omit=dev`. A
high-severity advisory in something a payment passes through should stop a
deploy. CI runs a second, non-blocking audit at `moderate` over everything
including dev dependencies — worth seeing, and deliberately not worth holding up
a payment fix for, because a linter advisory that blocks a deploy is a rule that
gets switched off the first week it fires.

There is deliberately **no style layer**: no quote, semicolon, indent or
line-length rules. Reformatting a codebase to satisfy a linter buries the commits
that change behaviour, and the reviews here are about behaviour. A formatter, if
it is ever wanted, should arrive as its own decision rather than as a side effect
of switching on a linter.

Without Docker, `npm run db:local` starts a user-space PostgreSQL and Redis on
non-default ports — no daemon, no `sudo` — and `npm run test:integration:local`
runs the integration suite against them. `npm run db:local:stop` shuts them down.

The integration tests skip unless `RUN_INTEGRATION=1` and a live database are
present, so `npm test` stays fast and offline.

**`.env.example` is the complete reference.** Every setting `src/config.js`
reads appears there or in this file with its default and the reason it exists,
and a test fails the build if one is added to the config without being written
down in either — a setting nobody can find is a setting nobody sets, and the
whole Mercantil C2P block had gone undocumented that way.

Generate production secrets with:

```bash
npm run secrets
```

It prints four 512-bit values and writes nothing to disk. The app refuses to
start in production with missing, short, duplicated or placeholder secrets. It
does **not** print the two key rings — `PAYMENT_CREDENTIALS_KEYS` and
`MFA_SECRET_KEYS` are a different format, `version:material`, and `.env.example`
carries the one-liner that generates one.

## What has to be configured

Two lists. The first stops the process from starting; the second only stops one
feature from working, and does it quietly enough that somebody will hit it in
front of a restaurant.

### Required, or the server will not start

`assertProductionConfig` in `src/config.js` runs at boot in production, so these
fail loudly at deploy time rather than at the first request:

| Setting | Rule |
| --- | --- |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `QR_SIGNING_SECRET`, `WEBHOOK_SECRET` | All four. Long, not the placeholder, and **all different** — reusing one secret for two purposes means a token minted for one is valid for the other |
| `DATABASE_URL` (or `DB_PASSWORD` with the discrete `DB_*` set) | One or the other |
| `CORS_ORIGINS` | Required, and `*` is refused |
| `MAIL_*`, `APP_BASE_URL`, `ONBOARDING_TEAM_EMAIL` | Only when `ONBOARDING_ENABLED=true`. Scoped to the flag so turning onboarding on is what makes them mandatory. `resend` requires `MAIL_API_KEY` and refuses a `MAIL_FROM` at a mailbox provider; `smtp` additionally requires `MAIL_SMTP_HOST`, `MAIL_SMTP_USER` and `MAIL_SMTP_PASSWORD` — **and a host that permits outbound SMTP, which Railway does not below Pro** |

`LOG_LEVEL` is refused above `warn` in production. Metrics are counted where
failures are logged, and pino skips its hook for a line below the configured
level — so raising it would silence the warnings *and* the metrics counted with
them. A monitoring hole with no symptom is the worst kind, so it is a boot
failure instead.

Redis is not asserted, because the app degrades rather than fails without it:
guest sessions fall back to Postgres, and rate limiting fails open everywhere
except `/auth`. It is still expected in production — the degraded mode is for an
outage, not a deployment choice.

### Off until configured, and quiet about it

These cost money per call or reach a third party, so they are opt-in per
deployment. Each refuses with its own 503. **A 503 normally means "try later" and
these do not** — they mean stop offering the feature on this server.

| Capability | Needs | Without it | How a client can tell in advance |
| --- | --- | --- | --- |
| **Read a menu from a photo** | `MENU_OCR_API_KEY`. `MENU_OCR_BASE_URL` defaults to OpenAI and selects the vendor | 503 `MENU_OCR_NOT_CONFIGURED` | `menuOcrAvailable` on `GET /api/v1/menu/settings` |
| **Second factor** | `MFA_SECRET_KEYS` | 503 `MFA_KEY_MISSING` on enrolment. Existing accounts keep signing in on passwords | `GET /api/v1/auth/mfa` |
| **Self-service registration** | `ONBOARDING_ENABLED=true`, plus everything the boot guard above then demands | 503 `ONBOARDING_NOT_CONFIGURED`. The router is not mounted at all — a stub answers, so no lead is recorded and no mail is sent | The code itself. It answered a bare 404 until a frontend, unable to tell that from a mistyped path, rendered an invented support address to a restaurant mid-application |
| **Store bank credentials** | `PAYMENT_CREDENTIALS_KEYS` | 503 `PAYMENT_CREDENTIALS_KEY_MISSING` | — |
| **Charge through Mercantil C2P** | `MERCANTIL_C2P_URL`, **and** credentials stored per restaurant, **and** those credentials proven by a real call | 503 `PAYMENT_PROVIDER_MISCONFIGURED` | `chargeable` on `GET /api/v1/account/banks` |
| **Self-service signup** | `ONBOARDING_ENABLED=true` and a mail provider | The routes are **not mounted at all** — 404, not 503 | — |
| **Foreign-currency menus** | `FX_ENABLED` (on by default) and a reachable BCV | 503 `FX_UNAVAILABLE`, but only after the stored-rate fallback is exhausted | `GET /api/v1/exchange-rate` |
| **Browsable contract at `/docs`** | `DOCS_ENABLED` (on by default) | Not served | — |
| **Prometheus metrics at `/metrics`** | `METRICS_TOKEN` | Not mounted — 404, not 401 | — |

**Declared Pago Móvil needs none of this.** A diner declares a transfer and a
member of staff confirms it against the bank app, which is why it is the rail
that works on a bare deployment and the right fallback when C2P is not wired up.

Where the last column names something to ask, ask it. Those endpoints answer
from configuration and the answer does not change between requests — it is the
difference between hiding a button and offering one that fails after somebody
has chosen a file and waited for it to upload.

The failure that prompted this: a live deployment offered the menu photo import
to every restaurant, because the client had no way to know the server had no
vision key. Somebody picked a photo of their carta, waited for it to upload over
LTE, and got told the feature was never available there.

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

### Reading from a host we do not run

Every external read is bounded on three axes, not two. A **timeout** stops an
upstream that has gone quiet and a **retry budget** stops us hammering one that
is failing — but neither does anything about a host that keeps talking, and
reading a response into memory with no ceiling is how a broken or hostile one
takes the process down with a body. So there is a **size ceiling** too, 2 MB,
about ten times the page actually parsed.

It is counted in bytes rather than characters, which is not academic on a
Spanish-language page: every accented character is one character and two bytes,
so a character count would admit a body at roughly twice the ceiling. Chunks are
collected as buffers and decoded once at the end, which also means a multi-byte
character split across two chunks survives.

Overflow is **fatal** — not retried. A body too large once will be too large
again, and three attempts is three times the memory for the same answer. Where
the server sends a `content-length` over the ceiling, it is refused before
anything is streamed.

The same ceiling applies to the bank. `MercantilC2PClient` reads its response
through the same helper, and an unreadable body classifies as
**`BANK_INDETERMINATE`** — the same answer a timeout gets, for the same reason:
we asked a bank to move money and do not know what happened. Calling it FAILED
would tell a diner their payment did not happen on the strength of a body nobody
read.

## Guest sessions

Scanning the QR exchanges it for an opaque bearer token. Only the SHA-256 of it
is ever written, so neither a database dump nor a Redis dump yields a usable
credential.

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
all.

### Two stores, holding different facts

Sessions used to live **only** in Redis, which made a cache the sole authority
on who may pay a bill. A restart, a `FLUSHALL`, or `maxmemory` evicting under
pressure signed out every diner in every restaurant at once — and, exactly as
above, they could not recover on their own, because the client has already
stripped the QR token out of the URL. Somebody had to get up and rescan the
sticker in the middle of paying.

So the two stores now hold different things, and the split is what keeps a
sliding session from costing a database write per request:

| | holds | if it is lost |
| --- | --- | --- |
| **Postgres** | who the session is, the absolute expiry, whether it was revoked | nothing works anyway |
| **Redis** | the idle timer, slid on every request | the next request re-reads the row and warms the cache |

`guest_sessions.expires_at` is the **absolute cap**, set once at creation and
never moved — the sliding TTL never touches Postgres. During a Redis outage the
fallback therefore enforces the more generous of the two windows, the cap rather
than the idle timeout, which is the right way round: a diner mid-meal keeps
paying, and a session left open in a drawer still dies on schedule.

Writes go to **Postgres first**, then the cache. If the cache write fails the
session still works; the reverse order would hand back a token that
authenticates only until Redis blinks. Revocation stamps `revoked_at` rather
than deleting the row, so a flush cannot resurrect a session somebody
deliberately ended by re-reading a row that never said so.

The one gap this leaves, stated rather than hidden: a session that passes its
cap while a cache entry is still live keeps working until that entry expires.
The idle timeout bounds that window, which is why it has to be the shorter of
the two numbers — there is a test asserting exactly that.

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

### Deleting a table, and creating it again

There is no `DELETE /api/v1/tables/{id}`. Deleting a table in the panel is
`PATCH { active: false }`, because the table carries bills, payments and audit
history that a button in a form has no business destroying.

That soft delete had a trap in it. The row survives holding its name under
`UNIQUE (restaurant_id, name)`, while dropping off the panel entirely — it
renders from `GET /api/v1/tables/floor`, which is active-only. Creating
*Mesa 5* again was then refused as already taken, by a table nobody could see
and nothing in the panel could bring back. A dead end reachable in two clicks.
(`GET /api/v1/tables?active=false` does list them, so the fact was reachable
over the API — just not from anything a restaurant looks at.)

So `POST /api/v1/tables` reactivates a deactivated row with that name instead
of refusing it, and answers `200` with the original table rather than `201`:
same id, same `created_at`, its bills still attached. Reviving the row is also
what keeps the **printed QR** working — a guest lookup requires `active = true`
(`src/routes/guest.js`), so the sticker on that table went dead when it was
deactivated and comes back with it. Minting a new row would leave that sticker
pointing at a table that no longer exists, with nothing on screen to explain
why the code stopped working. `POST /api/v1/tables/bulk` does the same for
names inside the range it was asked for, reported as `reactivated`; a
deactivated table outside the range is left alone.

A name an **active** table holds is still refused, which is a conflict the
panel can actually see. Renaming onto a deactivated name stays refused too —
reviving there would leave two tables wanting one name — but the error names
the table in the way and says it is deactivated, since that is the one case
where the blocker is invisible.

The audit log separates the two events: `TABLE_CREATED` for a table opened for
the first time, `TABLE_REACTIVATED` for one that came back.

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

### Sections

A menu is not a list, it is sections in an order, and `menu_categories` holds
them. A section rather than a `category` column on the product for one reason:
**order**. A text column can only sort alphabetically — Bebidas, Entradas,
Postres, Principales — which is wrong everywhere and cannot be corrected.
`position` is the point, and it belongs to the section rather than being
repeated on every product in it.

`GET /api/v1/menu/categories` lists them with a count each, plus
`uncategorisedCount`. Its own endpoint rather than a shape nested inside the
product list, because the two are paginated differently: a client renders every
header at once and pages through the food underneath, and headers derived from
one page of products would hide any section whose items fell past the limit.

Both product listings — staff and public — order by section position, then the
product's position within it, then name. Name is the tie-break rather than the
sort: everything imported at once shares a position, and
alphabetical-within-a-section is a reasonable default until somebody reorders.

**`category_id` is nullable and stays that way.** Products created before
sections existed have none, and a menu photo with no printed headings yields
none either. Both are *uncategorised*, which is a real state rather than a
missing value to be backfilled with a guess — so it sorts last and is reachable
as `?categoryId=none`. Without that filter the bucket has no id and would be the
one group a section-by-section client could not show.

Two constraint decisions worth knowing:

- The foreign key is **composite**, `(category_id, restaurant_id)` against
  `menu_categories (id, restaurant_id)`. A plain `REFERENCES menu_categories(id)`
  would let one restaurant file its food under another's section: the id exists,
  and nothing in the constraint says whose it is. Same correction
  `016_payment_tenant_integrity` made to payments.
- `ON DELETE SET NULL (category_id)` **names its column**, and must. On a
  composite key the unqualified form nulls every referencing column, which here
  would blank `menu_products.restaurant_id` — the tenant off the product —
  whenever a section was deleted. `030_bill_served_by` hit exactly that. Deleting
  a section leaves its food uncategorised and still sellable.

Deactivating a section hides its products from the public menu without touching
each one: the kitchen ran out of fish, and the whole block goes off for the
evening.

Still open: nothing reorders sections or renames them yet. `position` is set
from the order sections first appear in an import, and there is no endpoint to
change it — so the order a menu is imported in is the order it keeps.

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

### How the mail actually leaves

Three transports, chosen by `MAIL_TRANSPORT`, behind one `mailer.send`:

| Transport | What it does | When |
| --- | --- | --- |
| `log` | Writes the message, verification link included, to the logger and sends nothing. | Development. Refused at boot in production once onboarding is on — a flow whose link goes to a log file is one nobody ever finishes. |
| `smtp` | Signs in to an ordinary mailbox and sends as it. | Where outbound SMTP is permitted. It needs no domain, no DNS records and no provider account — **but see the host constraint below.** |
| `resend` | One POST to api.resend.com. | **What this deployment uses.** HTTPS on 443, so it works where SMTP ports are blocked. |

The split matters because of a constraint that is easy to meet late and painful
to discover late: **an API sender will only send from a domain you have verified
by DNS.** Resend, SES and Postmark all sign the `From` domain with DKIM records
you publish yourself, and nobody can publish records for `gmail.com`. Setting
`MAIL_FROM` to a Gmail address with `MAIL_TRANSPORT=resend` therefore fails at
the provider on every single send — and `mailer.send` never throws, by design,
so the symptom is a registration that returns `202`, a log filling with
`MAIL_SEND_FAILED`, and no verification link ever arriving. `config.js` refuses
to start on that combination instead, and the error names the remedy.

SMTP has the opposite property. Mail genuinely relayed through Google carries
Google's SPF and DKIM, so it is not a forgery and it reaches inboxes. What it
does not carry is our own domain, and a free account is capped at roughly 500
messages a day.

#### The host gets a say, and Railway says no

That reasoning is sound and it was still the wrong plan, because it is about the
*provider* and the binding constraint turned out to be the *host*.

**Railway disables outbound SMTP below the Pro plan.** Not port 25 — all of it.
Their own documentation is explicit: "Free, Trial, and Hobby plans must use
transactional email services with HTTPS APIs. SMTP is disabled on these plans to
prevent spam and abuse." So `MAIL_TRANSPORT=smtp` cannot work here at any port,
with any mailbox, however correct the credentials.

It cost an afternoon because of how it fails. Port 587 over IPv4 is dropped
rather than refused, so it surfaces as `ETIMEDOUT` after a full connect timeout
— indistinguishable from a slow relay. nodemailer then falls back to IPv6 and
gets `ENETUNREACH`, because Railway also leaves outbound IPv6 off by default.
Two unrelated-looking network errors, neither of which says "your plan forbids
this". The credentials were never reached, let alone wrong.

Both are documented Railway behaviours, and the second one names itself:
"While this setting is disabled, IPv6 connection attempts fail with 'Network is
unreachable' or `ENETUNREACH`."

**So this deployment sends over `resend`, from `splite.lat`.** That reverses the
advice this section used to give. It is also where the product was heading
anyway — a `gmail.com` sender is visibly not a company on the one email that
asks a restaurant to trust us with its till — so the host constraint only
brought the domain decision forward. Railway recommends the same thing even on
Pro: "we recommend transactional email services with HTTPS APIs for all plans."

The `smtp` transport stays. It is the right answer on a host that permits it,
and the point of three transports behind one `mailer.send` is that the host is a
`MAIL_*` change rather than a rewrite. **Check whether your host allows outbound
SMTP before choosing it** — Railway's own probe, run over `railway ssh`, is:

```bash
SMTP_HOST="smtp.gmail.com" bash -c '
for port in 25 465 587 2525; do
  timeout 1 bash -c "</dev/tcp/$SMTP_HOST/$port" 2>/dev/null \
    && echo "$SMTP_HOST port $port reachable" \
    || echo "$SMTP_HOST port $port unreachable"
done'
```

All four unreachable means the plan forbids it, and no port or credential change
will help.

#### Sending over Resend

```bash
MAIL_TRANSPORT=resend
MAIL_FROM='Splite <noreply@splite.lat>'
MAIL_API_KEY=re_…                       # sending access only, scoped to the domain
ONBOARDING_TEAM_EMAIL=splite.ve@gmail.com
```

The domain is verified once in the provider by publishing three records — a DKIM
`TXT`, an SPF `TXT`, and an `MX` on a `send.` subdomain. `ONBOARDING_TEAM_EMAIL`
stays a Gmail address: the restriction is on the *sender*, and receiving has
none of the constraints sending does.

Nothing in `src/` changed to move hosts. `TRANSPORTS.resend` was written before
any of this and is a single `fetch`.

#### Sending through a Gmail mailbox

Still supported, on a host that permits SMTP:

```bash
MAIL_TRANSPORT=smtp
MAIL_FROM='Splite <splite.ve@gmail.com>'
MAIL_SMTP_HOST=smtp.gmail.com
MAIL_SMTP_PORT=465          # implicit TLS; 587 flips MAIL_SMTP_SECURE off for STARTTLS
MAIL_SMTP_USER=splite.ve@gmail.com
MAIL_SMTP_PASSWORD=…        # a 16-character app password, NOT the account password
ONBOARDING_TEAM_EMAIL=splite.ve@gmail.com
```

The password is the one thing that trips people up: Google rejects the account
password over SMTP outright. An **app password** is generated per application at
myaccount.google.com, and the option only appears once 2-Step Verification is on
for the account. It is a credential that can send mail as that address, so it
belongs in the Railway variables beside the signing secrets and nowhere else —
never in `.env`, which is not committed for exactly this reason.

`ONBOARDING_TEAM_EMAIL` can be the same mailbox: it is where lead notifications
are *read*, and receiving has none of the constraints sending does.

The connection is built lazily and pooled, so a process that never sends mail —
every CLI script, and the API itself while onboarding is off — never opens a
socket or even loads the library. `src/server.js` closes it during shutdown,
because a pooled socket left open holds the event loop past the last request and
turns a graceful shutdown into a forced one.

There is deliberately no HTTP route for the invite step. Every authenticated
surface in this API is scoped to a restaurant the caller belongs to, and there is
no platform-operator role — inventing one to serve a handful of approvals a week
would be a second authentication model to secure and keep correct forever. The
team uses:

```bash
npm run onboarding -- list NEW
```

then `show <id>`, `contacted <id> [notas]`, `invite <id>`, `reject <id> [notas]`.

There is one more, and it is the one to run first:

```bash
npm run onboarding -- test-mail            # to ONBOARDING_TEAM_EMAIL
npm run onboarding -- test-mail otra@x.com # or wherever
```

`mailer.send` never throws, by design — a provider outage must not fail the
request that triggered it. The cost of that is a failure with no symptom where
it happens: a wrong app password produces a lead that is recorded, a `202` that
looks correct, and a notification nobody receives. `test-mail` exists to give
that failure a symptom. It reports the transport, the sender and the recipient,
prints the provider's actual complaint when a send fails — `535 Username and
Password not accepted` is the usual one, and it means the account password was
used instead of an app password — and exits non-zero, so it can gate a deploy.

Note that the lead itself is never at risk: it is committed to
`restaurant_signups` before any mail is attempted, and `npm run onboarding --
list NEW` reads it whatever the mail did. What a failed send loses is the
*notification*, not the restaurant.

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

## Second factor

Passwords are the only thing between a stolen laptop and a restaurant's
takings: an OWNER token reads every bill, confirms any declared payment, and
changes where the money is paid out. Login throttling makes *guessing* slow; it
does nothing about a password that has already leaked somewhere else, which is
the ordinary way accounts are lost.

**TOTP**, and that is not really a choice. Email codes need the mail provider
this deployment does not have yet, and SMS in Venezuela is both a cost per login
and a dependency on a network that is not always there. A TOTP secret works
offline, on a phone the staff member already carries. It is implemented in
`src/services/totp.js` rather than pulled in — forty lines of a standard that
has not moved since 2011, and a dependency in the authentication path is a
supply chain in the authentication path. `test/totp.test.js` runs RFC 6238's own
published vectors, which is the only real proof that every authenticator app
will agree with us.

With a factor enabled, **a correct password is not a session.** It returns
`{ mfaRequired: true, challenge }`, and the challenge is spent at
`POST /api/v1/auth/login/mfa` with a code. Branch on `mfaRequired`, not on the
absence of a token. The challenge names the account and nothing else — no role,
no restaurant — and cannot be presented as an access token: it carries
`type: 'mfa_challenge'`, and `authenticateToken` accepts only `type: 'access'`.
That check is what lets it share the access secret instead of introducing a
fifth one, and it is verified in both directions.

Enrolment is two steps on purpose. `POST /auth/mfa/enrol` mints a secret and
enables nothing; the account still signs in on its password alone until
`POST /auth/mfa/confirm` proves the authenticator holds the same secret. A
factor switched on by generation alone would lock out anybody whose phone failed
to scan the QR. Disabling costs a code too — a borrowed unlocked laptop would
otherwise strip the factor and leave the account on a password its borrower may
already have. Nothing here touches *another* user's factor, including for an
OWNER: a manager who can remove a colleague's second factor is a manager who can
take over their account.

**A code is spent once.** It stays valid for the whole of its thirty seconds, so
`users.mfa_last_step` records the last step accepted and anything at or below it
is refused — including the code that switched the factor on. One consequence
worth knowing: enrolling and then immediately signing in on a second device
inside the same thirty seconds will refuse the code showing on screen. It
resolves itself at the next step, and the alternative is a replayable code.

**Recovery codes are not a nicety.** There is no admin surface in this system —
inviting a restaurant is a CLI command — so an owner who loses their phone with
no code is locked out of their own business with nobody able to let them back
in. Ten are issued when the factor is confirmed, readable exactly once, and each
is spendable in place of a TOTP code. The response never says which kind
completed a login: distinguishing them would tell somebody holding a stolen
password whether they were guessing against six digits or eighty bits.

The secret is sealed at rest with AES-256-GCM under its own key ring
(`MFA_SECRET_KEYS`), deliberately not the payment one — a deployment with no
bank credentials must still be able to offer MFA, and a leaked payment key must
not also be a leaked authentication key. Both stores share one implementation in
`src/utils/sealedBox.js`. Without a ring configured, enrolment returns 503
rather than storing anything.

It is **optional per user**, and there is no enforcement point that requires it
of a role. That is deliberate for now rather than finished: a mandatory rollout
with no mail is a way to lock people out of their own accounts. Requiring it of
OWNER is a decision to take once there is a way to help somebody who gets stuck
— an administrator can now reset a password, which is most of that way.

## Staff

```
GET    /api/v1/account/users                    who works here
POST   /api/v1/account/users                    add somebody
PATCH  /api/v1/account/users/:userId            change a role, a standing, or both
POST   /api/v1/account/users/:userId/password   set somebody else's password
```

This existed only as SQL until recently. A restaurant was created with one owner
and could never gain a second account, and firing a cashier meant somebody with
database access running an `UPDATE` — on a system where **CASHIER and above
decide that money arrived**. That is not an access-control model; it is an
access-control model plus a promise.

OWNER and MANAGER reach these routes. Three rules decide what each may actually
do, and they live in `src/services/staff.js` rather than in the router, because
a rule enforced in a router is a rule enforced on the paths somebody remembered:

1. **Rank.** An owner may act on anybody but themselves. Everyone else may act
   only on a strictly lower role — and may only *grant* a strictly lower role.
   Without that second half, "may manage staff" silently means "may become an
   owner". A manager cannot touch a peer either: otherwise the first argument
   between two managers settles itself.
2. **Never yourself**, neither role nor standing. It stops an owner demoting
   themselves out of the only account that could undo it, and costs nothing —
   another owner can still do it for them.
3. **The last active owner stays.** Worth being precise about what this guards:
   serially it is unreachable, because once a restaurant is down to one active
   owner, only an owner may act on an owner, the only one left is themselves,
   and rule 2 refuses that. Rules 1 and 2 *are* the serial guard. The check
   exists for the race — both of the last two owners removing each other at the
   same instant, each reading the other as remaining — and so it is counted
   inside the transaction with the row already locked.

**Deactivating is not instant, and the response says so.** It revokes every
refresh session the person holds, so they cannot mint a new access token, and
returns `sessionsRevoked` as proof. The access token already in their hands
keeps working until it expires — at most `JWT_ACCESS_TTL`, fifteen minutes by
default. That is the standing cost of stateless tokens, and somebody removing a
person after an argument needs to know the door is not shut this second rather
than discovering it later.

A password reset revokes sessions for the same reason: a reset that leaves the
old sessions running has not locked anybody out. It is how a **forgotten**
password is recovered — an administrator sets a new one and tells the person.

A password somebody still knows is changed by them, at
`POST /api/v1/auth/password`, without going through anybody senior. There is no
user id in that path: the only account it changes is the one you are signed in
as. The current password is required, and that is the guard — an access token in
somebody else's hands should not be enough to take an account permanently.

It is deliberately **not** counted against the login throttle. That throttle
locks an *account* after enough failures, so wiring this into it would hand
anyone holding a stolen token a way to lock the real owner out — turning a
containable compromise into a denial of service against the person best placed
to fix it. The auth router's rate limit bounds the attempts instead.

It **answers like a login**, because that is what the caller now holds: every
refresh session is revoked and the returned pair are the replacements. The
device doing the changing stays signed in and every other one is signed out,
with `sessionsRevoked` counting them. Forcing somebody to sign in again on the
phone they just used is how a security action gets postponed.

What is still missing here is a **forgotten-password flow that does not need
another person** — that needs mail, which is optional in this deployment, so it
waits on the same decision self-service onboarding does.

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
`MENU_OCR_NOT_CONFIGURED` rather than failing oddly at upload.

The reader returns a `section` per item — the heading it appeared under — and
the import creates any section it has not seen, at the end of the menu, in the
order sections first appear in the payload. That is the printed order: the model
walks the page top to bottom. An existing section keeps the position it already
has, so a second import cannot renumber a menu somebody has since reordered.
`categoriesCreated` reports what it decided, because six sections named after
their own menu is how a reviewer knows it worked.

`MENU_OCR_BASE_URL` selects the provider — the request is the OpenAI-compatible chat-completions
shape several vendors serve, so switching is configuration rather than code.

**The base URL includes the version path**; only `/chat/completions` is appended
to it, because vendors put the version in different places:

| Provider | `MENU_OCR_BASE_URL` | A vision model |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` |
| Groq | `https://api.groq.com/openai/v1` | |
| OpenRouter | `https://openrouter.ai/api/v1` | |
| Mistral | `https://api.mistral.ai/v1` | `pixtral-12b-2409` |

A base URL without its version path produces a 404, which this endpoint reports
as `MENU_OCR_UNAVAILABLE` — the same answer it gives for a provider that is
genuinely down. The resolved endpoint is logged with `MENU_OCR_PROVIDER_REJECTED`
so the two can be told apart.

**Ask before offering it.** `GET /api/v1/menu/settings` carries
`menuOcrAvailable`, and a client should hide the photo import when it is false
rather than discovering the answer the hard way. Without it the only way to find
out was to offer the upload, let somebody choose a file, wait for several
megabytes to go up, and then answer 503 -- which is what a deployment with no key
did to every restaurant that tried. It is a fact about the server rather than a
transient failure, so `false` means hide it, not retry it.

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

## Menu sections

A menu is not a list. It runs starters, mains, desserts, and a text column can
only sort alphabetically — Bebidas, Entradas, Postres, Principales — which is
wrong everywhere and cannot be corrected. So sections are rows, with a
`position`, and the order belongs to the section rather than being repeated on
every product in it.

```
POST   /api/v1/menu/categories        create, at the end unless told otherwise
PATCH  /api/v1/menu/categories/{id}   rename, move, or take off the menu
PUT    /api/v1/menu/categories/order  the whole new order, as an array of ids
DELETE /api/v1/menu/categories/{id}   remove the heading, keep the food
GET    /api/v1/menu/categories        with a count per section, and the loose ones
```

An OCR import creates sections from the headings it read, in first-appearance
order, which is the printed order — the reader walks the page top to bottom.
That is right for a first menu and no use afterwards, which is what these are
for.

**Reordering sends the whole order, not one move.** The array *is* the order:
`position` becomes the index. One PATCH per section would make every
intermediate state a state somebody could read — two sections both claiming
position 3 while the next request is in flight — and a dropped request would
leave the menu in one permanently. It runs in a transaction, because the
statement matches only the caller's own rows: a list padded with another
tenant's ids would reorder the rest and *then* fail, so rolling back is what
makes the 404 mean nothing happened.

**Deleting a section does not delete its food.** The foreign key is `ON DELETE
SET NULL (category_id)` — naming the column, because the unqualified form on a
composite key would blank `restaurant_id` too and take the tenant off the
product. Its dishes fall back to uncategorised, still active and still
sellable. Taking them with the heading would be a way to lose a menu by tidying
it.

`active: false` is the other removal: the whole section goes off the public menu
with its products intact, because the kitchen ran out of fish.

## The menu as a file

Not every restaurant wants to transcribe a menu. Plenty have a PDF their
designer sent them that changes twice a year, and asking them to type it in
before Splite shows a diner anything is asking for the wrong thing first.

```
PUT    /api/v1/menu/pdf                       upload (multipart, field `file`)
GET    /api/v1/menu/pdf                       what is stored, described
DELETE /api/v1/menu/pdf                       remove it
GET    /api/v1/menu/public/{restaurantId}/pdf the diner's copy, unauthenticated
```

One file per restaurant — the primary key is the tenant, so replacing the menu
is an upsert rather than a second row and a rule about which one wins.

**This is not the OCR route.** `/menu/ocr-extract` reads a menu in order to
throw the file away and keep the prices; this keeps the file and shows it. A
bill is still built from priced rows in `menu_products`, and nothing uploaded
here can be added to one. The PDF is for reading.

The bytes live in Postgres, in a table of their own rather than columns on
`restaurants`: a `bytea` on the restaurant row travels with every query that
forgets to name its columns, and that row is read on nearly every request. A
`CHECK` keeps `size_bytes` equal to `octet_length(bytes)`, so a listing can
report the size without reading the file.

Uploads are checked for the `%PDF-` header as well as the declared content type.
That is not a security boundary — the file is served back as what it says it is,
with `nosniff`, and never executed — but it catches somebody uploading a
photograph of their menu to the wrong route, and says so.

`GET /menu/public/{restaurantId}/products` carries `menuPdf` (or `null`)
alongside the products, so a client can decide between embedding and linking,
and a menu that is *only* a PDF still has something to show when `products`
comes back empty.

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

`phone` must be a **mobile** line — `0412`, `0414`, `0416`, `0422`, `0424`,
`0426`. A landline cannot receive a Pago Móvil at all, so accepting one
configures a payee that can never be paid, and the diner finds that out rather
than the restaurant. `0422` was added after a live C2P checkout was seen
offering it: a diner on that range could not have paid us, and the error we gave
them said their own number was not Venezuelan.

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

> **The bank list is still not officially sourced**, though it is no longer only
> from memory. It has been cross-checked against two independent published lists,
> which agreed with every code already in it and added three that were missing
> (`0146` Bangente, `0173` Banco Internacional de Desarrollo, `0178` N58). The
> only disagreements were names, both of them renames: `0169` Mi Banco is now
> R4, and `0175` Banco Bicentenario became Banco Digital de los Trabajadores in
> July 2024. Codes did not move, so payees configured under the old names still
> work.
>
> The authoritative document exists — the BCV publishes the institutions active
> in the SCCE — and we still have not read it: `sudeban.gob.ve`,
> `www.sudeban.gob.ve` and `cbn.org.ve` do not respond, and `bcv.org.ve` is
> blocked from our network. The dead ends are recorded in
> `src/payments/banks.js` so nobody repeats them; what is left is fetching that
> PDF from a network that can reach the BCV, or asking a bank directly, since
> Mercantil gives its integrators the `destination_bank_id` list.
>
> **A bank picker elsewhere is not a registry.** A live Venezuelan C2P checkout
> was compared against this table and offered eleven institutions we do not
> list — but most are dead, including Banco Industrial de Venezuela, ordered
> into liquidation in 2016. Its dropdown is a snapshot of whenever it was last
> edited. The live ones it named were added; the rest deliberately were not,
> because listing a dead bank lets a restaurant configure a payee that can never
> receive money.
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

**What the verifier is given to match on.** The reference is required and is
what makes a claim checkable at all. Three optional fields make it quick, and
they are the three a receiving bank prints beside the movement:

| Field | Shape | Why |
| --- | --- | --- |
| `phoneOrigin` | a Venezuelan mobile line | a Pago Móvil has no other origin, so a landline here is a typo in the one field that finds the movement |
| `bankOrigin` | a four-digit bank code | "Banesco", "banesco" and "BANESCO 0134" are one bank that compares as three |
| `idOrigin` | a cédula or RIF | the strongest of the three — a phone can be borrowed and a bank is shared by millions |

All three are optional: a diner who cannot supply them is still a diner who
paid. But they are validated as the facts they are rather than accepted as free
text, because the person who pays for a sloppy value is the one reading it off a
screen with a bank app open in the other hand. Staff see them through
`staffPaymentClaim`, which also resolves `bankOriginName` — the diner-facing
`paymentClaim` carries none of it, since the guest surface is reachable by
anyone who scans a sticker on a table.

`bankOrigin` became a code after it had been free text, so claims declared
earlier may carry a name. Those are shown as they were given with
`bankOriginName: null`, because somebody working last week's queue is better
served by an imperfect answer than by a blank.

**Nothing pushes.** That makes an unwatched queue the weak point of the rail
that actually carries money today: a diner declares a payment, nobody opens the
screen, and they leave believing they have paid. Two things make it audible
without waiting for a notification service:

- `GET /api/v1/payments/claims/summary` returns `pending`,
  `oldestPendingAt` and `oldestPendingAgeSeconds` — cheap enough to poll from
  every screen in the room, on its own partial index (migration 026), and
  separate from the queue itself so a badge is not pulling claim rows and payer
  phone numbers to render a number. Any authenticated role can read it,
  including WAITER: a waiter cannot decide money arrived, but they are the
  person standing in the room. Poll at a human interval — 15 to 30 seconds, not
  per second; it shares the API rate limit with everything else the till does.
  The **age** is the half that matters. A count cannot tell a claim that arrived
  ten seconds ago from one ignored for an hour, and those are opposite
  situations. It is computed server-side, so a browser with a skewed clock
  cannot invent either one.
- The reconciler reports claims still pending beyond
  `RECONCILE_UNWORKED_CLAIMS_HOURS` (2) as *attention*, alongside the C2P queue
  — see [Reconciliation](#reconciliation). Two hours is well past any plausible
  service window for one table, so a claim that old is not a busy night, it is a
  queue nobody is working. This is the half that needs no frontend at all: with
  no screen ever built, a neglected evening still reaches whoever reads the
  nightly run.

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

That guarantee is a **string comparison**, so it only holds while a movement has
one spelling. Mercantil's charge endpoint quotes a reference grouped
(`9000 0000 0999`) and its search endpoint returns it plain
(`900000000999`); stored as they arrived, those are two rows — the index does
not collide, the resolver's spent-movement probe does not match, and the same
debit settles two tables. Every write and every comparison now goes through
`canonicalReference`, which collapses a value that is only digits and separators
down to its digits. It deliberately leaves anything carrying a letter alone: a
`providerPaymentId` such as `TX-4F2A-9` is an identifier rather than a number,
and stripping it to `429` would lose it and invite a collision with a real
reference. Leading zeros are kept too, so `0900…` and `900…` stay distinct —
merging references that may genuinely differ is a worse failure than leaving one
split, and if Mercantil turns out to pad inconsistently, that is a question for
them rather than a guess for us. A value that is *only* separators is kept
verbatim as well: the unique index is partial (`WHERE provider_payment_id IS NOT
NULL`), so blanking it would leave that movement unconstrained and free to
settle a second bill — the very thing being prevented.

Migration 025 backfills the rows written under the old rule, and checks for
collisions first so a failure names the payments rather than surfacing as a bare
constraint violation. **That failure repeats on every deploy, deliberately.**
The migration ledger row is written in the same transaction as the migration, so
a failure records nothing and the next deploy stops in the same place; there is
no skip and none should be added. Two payments holding one movement is a double
settlement, a person has to refund one of them, and until they do, holding back
every later migration is the correct outcome.

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

## The service dashboard

```
GET /api/v1/payments/dashboard          the room, the queues and the takings
GET /api/v1/payments/activity?since=…   what has happened since you last looked
GET /api/v1/tables/floor                per table, with its open bill
```

Every one of these figures could be assembled by a client from endpoints that
already existed. That is exactly why they are here: **assembling them meant
adding up money in a browser**, and amounts cross this wire as strings precisely
because `Number` loses precision past 2^53. A total a client summed is the one
figure nobody checked. They are summed in Postgres instead, in one call.

`outstandingVes` is the number a manager looks at first — what the room still
owes, due minus paid, and not something a client should compute by subtracting
two strings.

**A declared Pago Móvil is not takings.** It appears under `claims.pending` and
leaves `outstandingVes` alone, because a diner saying they paid is not money
until somebody has found it in the bank app. The takings figure reads settlement
from the transition to SUCCEEDED rather than from when the row was created, for
the same reason the tips report does.

### On "today"

There is no timezone on a restaurant, and this product is Venezuela-only, so an
unset `from` means the start of the current day **in America/Caracas**. In UTC a
service ending at 23:00 local lands in tomorrow, which would make the takings
wrong for the last four hours of every evening. A service that crosses midnight
should pass `from` explicitly — the same rule the tips report teaches.

### Knowing a payment landed

`GET /api/v1/payments/activity` is a cursor, not a push. Poll it with the `asOf`
from the previous response; entries come oldest first, so the last one is the
next cursor, and `asOf` is returned even when nothing happened so a poll
advances instead of re-scanning the same window forever.

Two kinds, because they call for different reactions: **`SETTLED`** is money
that became real, and **`DECLARED`** is a diner who says they paid and needs
somebody to open the bank app. Each carries the **table name**, because nobody
recognises a uuid across a dining room.

A real push notification needs a service worker, a subscription store and a
sender, none of which are built. This is what makes polling cheap enough that
the absence does not matter for a screen somebody is already watching.

### The floor, per table

`GET /api/v1/tables/floor` gains `openedAt` and `openMinutes` — how long the
table has been sitting, which a manager reads as either "they are ready for the
bill" or "something has gone wrong" — plus `pendingClaims`, the diners at that
table who say they have paid and nobody has checked, and `tipVes` so a table
that tipped well is visible while its diners are still there.

`openMinutes` is computed server-side on purpose: a browser subtracting dates
does it against the visitor's clock, which is how a table comes to read as
opened in the future.

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

### Whose tips these are

```
GET /api/v1/payments/tips/mine?from=…&to=…   your own
GET /api/v1/payments/tips?from=…&to=…        the shift, including byServer
PATCH /api/v1/bills/:id/server               correct who served a table
```

Tips have been recorded per payment since migration 024 and reported per shift
since. What never existed was any link between a bill and the person who served
it — so the report could tell a restaurant what it owed its staff in total, and
could tell no individual member of staff what they had earned.

That is the half that changes behaviour. **A pooled figure a manager reads once
a week is an accounting line; a number a waiter watches climb during their own
shift is an incentive**, which is the reason to build tipping into the product
at all.

`bills.servedBy` is set to whoever opens the bill. That is right when the person
taking the order opens it — which is the usual path, since adding the first
order is what creates the bill — and wrong when a host or cashier opens it for
somebody else. So it is correctable, by OWNER and MANAGER, and audited, because
it moves money between people.

**A correction is retroactive, deliberately.** Attribution is read through the
bill's *current* server at query time rather than snapshotted when the payment
settled, so fixing who served a table fixes the tips that followed from it. A
correction that left yesterday's money against the wrong name would not be one.
That is also why a waiter cannot reassign their own tables.

Bills with no server — everything predating the column — report under a null
`userId` rather than being dropped. Hiding them would make the parts stop
summing to the total, which is exactly the kind of silent gap somebody finds
while dividing cash.

`/tips/mine` takes no user id: it is always the caller's own. A waiter seeing
their own total is the whole incentive; seeing everybody else's is a different
feature with a different conversation behind it, and a manager already has
`byServer`.

### Is tipping actually working?

A total cannot answer that — a bigger number on a busier night says nothing. The
report carries `billedVes` beside `totalTipsVes` and a **`tipRateBps`**: tips as
basis points of what was billed, so 840 is 8.40%.

Basis points and integer arithmetic, for the reason IVA and the service charge
are bps: a rate gets compared against a target, and 8.4 that is really 8.399999
is a number somebody argues with. Null when nothing was billed — zero would read
as "nobody tipped", and "there was nothing to tip on" is a different fact about
a shift.

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

The period is read from **when the payment settled**, not when its row was
created. For a card or a cash sale those are the same instant. For a declared
Pago Móvil they are not: the row is created when the diner says they paid, and
it settles when a member of staff finds the transfer in the bank app — which can
be hours later, and can be after midnight.

This reverses an earlier decision, so the argument is worth keeping. Reporting on
creation files a tip in the shift it was *earned* in, which is the fairer answer
to "whose tip is it". But it made a closed shift's number **retroactively
mutable**: a claim declared at 23:50 and confirmed at 00:10 was absent from
Friday's report at midnight and present in it on Monday. Whoever divided the cash
on Friday night divided the smaller number, and nothing told them a later
confirmation would change it.

A figure that money is handed out against has to be final once the shift is over.
Settlement time gives that: after the queue is worked, a past window never moves
again. The cost is a real one — a tip earned before midnight and confirmed after
it appears in the next shift's figures — and a restaurant that cares about which
crew earned it should work the claims queue before closing the till, which is
worth doing anyway for the reason the queue exists.

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
| `ITEMS` | participants claim lines, whole or by units; a shared claim splits between its claimants |
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

`ITEMS` allocates in three stages, all largest-remainder — the balance across the
lines by subtotal, then each line's result across the claims on it by units, then
each claim's result across the people on it, evenly. Every line must be claimed,
because an unclaimed line is money owed by nobody and the parts could not sum.

A line may be claimed **by units**: `quantity` on a claim says how many of the
line's units it covers, so *three beers, two on Ana's tab and one on Luis's* is
two claims on one `itemId`. Where a line is claimed more than once, the
quantities must add up to the line's own quantity — claiming two of three leaves
a unit owed by nobody, and the split is refused with `SPLIT_CLAIMS_INCOMPLETE`
rather than silently short. A claim that omits `quantity` claims the whole line,
which is what a claim meant before quantities existed, so clients written
against the older shape keep their meaning exactly. `CUSTOM` refuses amounts that do not add up rather than rounding
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
per diner and, for `ITEMS`, who is on which line in `bill_split_items` — one row
per (line, participant), so a person on one line in two claims is one row. The
money is in the shares, computed per unit; these rows record participation. Both of
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

### What a scan lands on

A scanned code does not have to mean "open the bill". A diner reaching for a
phone at a table is as likely to want the menu, and a session is the wrong
price for reading one — so the code resolves first, and the diner chooses:

```
POST /api/v1/guest/qr/context   ->  { restaurant, table, hasOpenBill }
                                     |
                   menu ------------ +------------ bill
                     |                              |
GET /api/v1/menu/public/{restaurantId}/products    POST /api/v1/guest/sessions
(no session)                                       (the existing flow)
```

Before this route the menu was unreachable from a QR at all: the public menu
endpoints need a restaurant id, and the only way to learn one was to mint a
session first. Both things a person does at a table were behind the same door.

`POST`, not `GET`, alone among the read surface. The token would otherwise sit
in `req.url`, which the access log records on every request. It is a low-value
credential printed on furniture in a public room, but there is no reason to copy
it into every log line to save a verb.

The response carries no money. `hasOpenBill` is the one fact the landing needs —
whether to offer the bill at all — and it says only what anyone standing in the
room can already see. What the table owes stays behind the session.

Both public routes that accept a printed code run the same checks from one
function: the HMAC, a tenant-scoped table lookup, `active` on the table and its
restaurant, and the nonce. Every failure is the same `QR_INVALID`, message
included — a code stuck to a table is read by strangers, and distinguishing
"no such table" from "rotated nonce" would answer questions about a restaurant
to somebody holding a photograph of its furniture.

## Guest access

A diner scans a table QR, exchanges it for a session, and reads their bill:

```
POST   /api/v1/guest/qr/context          resolve a printed code, no session
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

### Going backwards

**There are no down migrations, and that is the design rather than the gap it
looks like.** Writing thirty reverse scripts is the obvious answer and the wrong
one: most of them are not honestly reversible — dropping a column back does not
return the data that was in it — and a set of scripts nobody has ever run is a
set of scripts that does not work, discovered at the worst possible moment.

What makes a rollback possible instead is a property every migration has to
hold:

> A migration must leave a schema the **previous release's code** can still run
> against.

Hold that and rolling back is redeploying the previous image and nothing else —
no schema step, no window where the two disagree. It also means a deploy is safe
in the other direction: the migration runs before the new code is serving, and
the old code is still serving while it runs.

In practice that means **expand, then contract, a release apart**. Add the new
column, backfill it, and let both live for a release; drop the old one only once
nothing running reads it. `payments.tip_ves` and `guest_sessions` are both
shaped that way.

Three migrations break the rule — `006`, `008` and `009` — and each says so at
the top of the file, in the words `NOT-BACKWARD-COMPATIBLE` and the reason. All
three predate the first deployment, when there was no previous release to
strand. Rolling back past one of those means restoring a backup, not redeploying.

A test enforces all of this: it fails on a migration that drops a table or
column, changes a column type, adds `NOT NULL` to an existing column, renames,
truncates or deletes rows — unless the file carries that marker. It also pins
the list of marked files at exactly those three, so a fourth is a decision
somebody takes deliberately and defends in review rather than discovers in an
incident. And it checks that every `CREATE TABLE`/`CREATE INDEX` carries
`IF NOT EXISTS`, so replaying against a restored database is not an error
somebody has to reason about while the service is down.

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

### Metrics

Logs answer *what happened*. They do not answer *how often, and is it getting
worse* — so nobody could see a C2P failure rate climbing or a claims queue going
forty deep without grepping for it or running the reconciler by hand, and both
of those are things somebody does after a restaurant complains.

`GET /metrics` serves Prometheus text, behind `METRICS_TOKEN` as a bearer.
Unset, the route is not mounted at all: this response names every queue in the
installation and how far behind each one is, and an endpoint that exists but
refuses is an endpoint somebody probes.

**Counters are collected at the logger, not at call sites.** Every failure this
service knows how to have already goes through one funnel — a `warn` or `error`
carrying a stable `event` — so a pino hook counts there. A new failure mode
becomes a metric the moment somebody logs it rather than the moment somebody
remembers to instrument it, and the metric vocabulary is the event vocabulary
already in use. Instrumenting by hand would have meant twenty-seven edits and a
twenty-eighth that somebody forgets, which is precisely how `AUDIT_WRITE_FAILED`
came to be swallowed with nothing watching.

```
splite_events_total{event="AUDIT_WRITE_FAILED",level="error"} 3
splite_pending_claims 12
splite_oldest_pending_claim_age_seconds 5400
splite_unresolved_c2p{status="IN_DOUBT"} 2
splite_unresolved_c2p{status="AMBIGUOUS"} 0
```

The gauges are read at scrape time from the ledger, so they are exact rather
than accumulated, and they are deliberately **cross-tenant**: this endpoint
answers to whoever runs the service, and "somebody's diner has been waiting two
hours" is the same alert whichever restaurant they are sitting in. A series at
zero is emitted rather than omitted — a vanished series reads as *no data* on a
dashboard, not as *nothing waiting*.

A gauge that throws is skipped rather than failing the scrape, and the failure
is counted like any other, so the gap explains itself in the same response. A
monitoring endpoint that goes dark because one query failed removes the
visibility it exists for, at the moment it is most wanted.

There is deliberately **no payment counter**. The obvious one — increment on
each state transition — would have to fire inside the caller's transaction,
which is the only place that knows a transition happened; a transaction that
rolled back afterwards would leave the count claiming money moved when none did.
A number about money that can be wrong is worse than no number. The ledger holds
the exact answer, so throughput belongs in a gauge over `payments`, which needs
an index shaped for the window it asks about — a decision to take on its own.

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
7. **When a deploy never becomes healthy, read stderr first.** A container that
   dies before `app.listen` shows up in a hosting dashboard as repeated
   healthcheck retries and `replicas never became healthy` — the symptom, with
   nothing about the cause. The cause is written twice: once as a structured
   `STARTUP_FAILED` record on stdout, for querying later, and once in plain text
   on stderr between two rules:

   ```
   ================================================================
   STARTUP FAILED: MAIL_FROM=team@gmail.com cannot be used with MAIL_TRANSPORT=resend: ...
   ================================================================
   ```

   The second exists because the first is a single ~1KB JSON object, and a log
   viewer that collapses long lines hides precisely the one line worth reading.
   Only three things run before the port is bound — `assertProductionConfig`,
   the Postgres check, and the Redis connection — so that sentence names which.

## Retention

Five tables grow forever and none is consulted after a point. `npm run purge`
clears them; `npm run purge -- --dry-run` counts without deleting. Guest sessions
are the newest of them: a session is dead the moment its absolute cap passes and
nothing reads one afterwards, but they are kept a day past expiry so a question
about an evening can still be answered the morning after. Nothing here
is urgent — a purge that misses a week deletes a week more the next time. It
runs daily on a schedule; see
[Scheduled maintenance](#scheduled-maintenance).

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

It also reports, as *attention* rather than failure, declared Pago Móvil claims
still unconfirmed beyond `RECONCILE_UNWORKED_CLAIMS_HOURS` (2) — see
[Declared Pago Móvil](#declared-pago-móvil) for why an unwatched queue is the
weak point of that rail — and C2P charges left `IN_DOUBT`,
`AMBIGUOUS` or `PENDING` beyond `RECONCILE_UNRESOLVED_C2P_HOURS` (6). The first
two are correct states, not broken ones, but the diner has been debited and is
waiting on a person, so a queue that has stopped being worked should not stay
silent. `PENDING` is the odd one: it is what a charge is *while the bank is
being called*, so it is normal for seconds and impossible for hours — one this
old is a charge whose outcome was never recorded, and the only kind nothing else
would surface.

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
| ~~**On what domain does Splite send?**~~ **Answered: `splite.lat`.** | Nothing. Onboarding mail sends over `MAIL_TRANSPORT=resend` from a verified domain. | Closed. It was answered earlier than planned because the host forced it: Railway disables outbound SMTP below Pro, so sending through the team's Gmail mailbox — which this table previously recommended — cannot work there at all. See [How the mail actually leaves](#how-the-mail-actually-leaves). No code changed; it was three variables. |
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
- **Nothing pushes a claim to staff.** The backend now supports a badge —
  `GET /api/v1/payments/claims/summary`, plus a reconciler line for a queue
  nobody worked — but a screen showing it, or a real push notification, is still
  a frontend decision and is not built. See
  [Declared Pago Móvil](#declared-pago-móvil).

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
- Guest sessions bound to the current bill. The durable half of this has landed
  — there is a `guest_sessions` table, and a cache flush no longer signs a
  dining room out (see [Guest sessions](#guest-sessions)) — but it is keyed on
  the **table**, not on `bill_id`. Binding a session to one bill is still a
  model change rather than an addition: it would mean a session ending when the
  bill closes, which is a different product decision from a session ending when
  the diner leaves. (Split shares are persisted in their own tables — see
  [Splitting a bill](#splitting-a-bill) — rather than waiting on this.)
- Per-unit claims are not persisted *as* units. The engine divides by
  `quantity` and the resulting shares are stored exactly, but
  `bill_split_items` holds one row per (line, participant) and no quantity
  column, so reading a stored split back tells you who was on a line and what
  they owe, not how the units were apportioned. Recovering that would be a
  quantity column and a relaxed uniqueness rule on that table.

### Phase 2, not started

- **A real provider adapter.** The webhook route is mounted and
  `src/middleware/webhookSignature.js` is wired to it, but the only provider
  defined is `SPLITE` — our own HMAC scheme. A Venezuelan rail is an entry in
  `PROVIDERS` supplying its own verifier and parser, and nothing else changes.

### Security and correctness

- **Access tokens cannot be revoked** within their 15-minute life, so "revoke"
  only ever affects refresh tokens. Acceptable at that TTL. The Redis refresh
  mirror that claimed to solve it has been removed: nothing read it, and nothing
  usefully could, since the access token carries no `jti` and the refresh path
  has to read Postgres anyway in order to rotate.
- **The app-level rate limiter still cannot key on a user**, being mounted ahead
  of authentication. It is now only a coarse backstop: the bills router and the
  guest router each apply their own limiter after authenticating, keyed on the
  staff subject and the guest session respectively.
- **`/health/ready` is an unauthenticated database round-trip**, deliberately
  ahead of the rate limiter so probes do not consume client budget. That also
  makes it free load for anyone who finds it.

### Tooling

- **`scripts/` still uses `console.*`.** Only `src/` was converted to structured
  logging; the migrate and seed CLIs were left alone deliberately, but a deploy
  step arguably deserves structured output too.
- **Dead code:** none known. `requireTenant` and `registerSchema` were exported
  and never called, and have been deleted — an unused export is a thing a
  reviewer has to reason about and a thing a future caller may reach for
  believing it is load-bearing. `revokeAllSessionsForUser` was on that list too
  and is now genuinely used, by staff deactivation and by a password change.

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
