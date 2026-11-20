# Splite backend

The API behind [Splite](https://splite.lovable.app), pay-at-table for
Venezuelan restaurants. A diner scans the QR on their table, sees the bill,
splits it, orders, and pays by Pago Móvil. Staff run the floor, confirm
payments and manage the menu from a panel.

Settlement is always in bolívares. Menus may be priced in VES, USD or EUR, and
the BCV rate is frozen when a bill opens, so a diner's total cannot move while
they eat.

- **Stack:** Node 22, Express, PostgreSQL, Redis. Deployed on Railway.
- **Contract:** OpenAPI 3.1 in [`openapi.json`](openapi.json), generated from
  `src/contract` and checked in CI. Served at `/docs` outside production.
- **Frontend:** [VartanKazarian/splite](https://github.com/VartanKazarian/splite)
  (TanStack Start, built and hosted with Lovable).

## Documentation

| Read this | For |
| --- | --- |
| This README | What exists, running it, configuring it, deploying it |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How each part works and why: sessions, bills, splits, payments, ordering, fiscal invoicing, rate limits, retention… |
| [`docs/FRONTEND_BRIEF.md`](docs/FRONTEND_BRIEF.md) | Conventions a client cannot infer from the spec |
| [`docs/bank-connections.md`](docs/bank-connections.md) | How bank movements reach Splite and confirm payments |
| [`docs/operator-console.md`](docs/operator-console.md) | The team console, subscriptions and the first operator |

## What it does

**Diners (no app, no account)**
- Scan a signed QR → a guest session bound to that table's current bill.
- See the bill live, split it (whole, equal, by items, custom amounts), tip.
- "Ana is paying": a share is held while someone is in their bank app, so two
  people cannot pay the same part.
- Declare a Pago Móvil and follow it live: waiting, confirmed, or rejected.
- Order from the menu. Optionally, a new phone's first order waits for staff
  approval and expires after 15 minutes if nobody decides.
- Receipt for every payment. Fiscal invoices only through an authorised
  provider (none configured in production today).

**Staff (owner, manager, cashier, waiter)**
- Floor view, bills, line items, tables and printable QR codes.
- Payment confirmation queue, with automatic matching against bank statements,
  signed webhooks or Mercantil notifications.
- Order tray with audible alerts; approve/reject for new phones when enabled.
- Menu with sections, photos, a menu built from a photo, and a menu PDF.
- Tips per shift, staff and invitations, optional TOTP second factor.

**Splite team**
- Operator console: plans, subscriptions, charges, leads and onboarding.
- After paying, diners rate the meal (stored privately; every rater is offered the
  restaurant's Google review link) and can send themselves a signed link to
  their receipt on WhatsApp.
- Staff push notifications (Web Push) on locked phones: payment notices to
  verify go to cashiers, orders from the table to the floor. No setup: the
  VAPID key pair is generated on first use.

**Security, in short**
- Tenant-scoped queries everywhere; RBAC by rank; Argon2id passwords.
- 15-minute access tokens; refresh sessions of 12 h idle / 16 h maximum,
  rotated with reuse detection, optionally in an HttpOnly cookie.
- Hashed guest tokens, signed and rotatable QR codes, Redis rate limits that
  fail closed on `/auth`, idempotency keys and row locks on money paths,
  append-only payment ledger, audit log.

**Not built:** card payments (needs an acquirer), a live direct bank
API (statement upload and webhooks work with every bank). Mercantil C2P is code
complete but its wire format is unconfirmed, so it is not used for real money.
The full list is in [Open points](docs/ARCHITECTURE.md#open-points).

## Running it locally

```bash
cp .env.example .env
npm install
docker compose up -d db redis          # or: npm run db:local (no Docker, no sudo)
npm run migrate
SEED_OWNER_EMAIL=owner@example.com SEED_OWNER_PASSWORD=a-long-dev-password npm run seed
npm start
```

| Command | Does |
| --- | --- |
| `npm test` | Unit tests (fast, offline) |
| `npm run test:integration:local` | Integration tests against the `db:local` Postgres and Redis |
| `npm run lint` | ESLint (correctness rules only, no style rules) |
| `npm run openapi:dump` / `openapi:check` | Regenerate / verify `openapi.json` |
| `npm run audit` | Blocking audit of production dependencies |
| `npm run secrets` | Print fresh production secrets (writes nothing) |

Integration tests skip unless `RUN_INTEGRATION=1` and a live database are
present. **`.env.example` is the complete settings reference**, and a test
fails if a setting is added to `src/config.js` without being documented.

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
| `MAIL_*`, `APP_BASE_URL`, `ONBOARDING_TEAM_EMAIL` | The `MAIL_*` settings are required when `ONBOARDING_ENABLED=true` **or** when `FISCAL_PROVIDER` is set, because both send mail that a person is waiting for — a verification link, or their invoice. `APP_BASE_URL` and `ONBOARDING_TEAM_EMAIL` stay tied to onboarding alone; invoicing uses neither. Scoped to a condition rather than always, so a deployment that does neither still boots without a mail provider. `resend` requires `MAIL_API_KEY` and refuses a `MAIL_FROM` at a mailbox provider; `smtp` additionally requires `MAIL_SMTP_HOST`, `MAIL_SMTP_USER` and `MAIL_SMTP_PASSWORD` — **and a host that permits outbound SMTP, which Railway does not below Pro** |

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
| **Issue fiscal invoices** | **Off in production** — see [Issuing it ourselves](docs/ARCHITECTURE.md#issuing-it-ourselves). `FISCAL_PROVIDER`. Either `own` — Splite issues and numbers them itself, against the series each restaurant has configured — or the name of an authorised imprenta digital with an adapter. `FISCAL_MOCK_ENABLED=true` registers the mock instead, and **the boot guard refuses it in production** — its documents carry invented `MOCK-` numbers. Setting `FISCAL_PROVIDER` in production also makes the `MAIL_*` settings mandatory, because an issued invoice is emailed to whoever asked for it | 503 `FISCAL_PROVIDER_NOT_CONFIGURED`, and under `own` a restaurant with no series gets 409 `FISCAL_SERIES_MISSING` | `plan.capabilities.fiscalInvoicing` on `GET /api/v1/account`, which answers the separate question of whether the plan includes it |
| **Charge through Mercantil C2P** | `MERCANTIL_C2P_URL`, **and** credentials stored per restaurant, **and** those credentials proven by a real call | 503 `PAYMENT_PROVIDER_MISCONFIGURED` | `chargeable` on `GET /api/v1/account/banks` |
| **Foreign-currency menus** | `FX_ENABLED` (on by default) and a reachable BCV | 503 `FX_UNAVAILABLE`, but only after the stored-rate fallback is exhausted | `GET /api/v1/exchange-rate` |
| **Browsable contract at `/docs`** | `DOCS_ENABLED` (on by default outside production, **off in production**) | Not served | — |
| **Prometheus metrics at `/metrics`** | `METRICS_TOKEN` | Not mounted — 404, not 401 | — |
| **Which dependency is down, on `/health/ready`** | `HEALTH_DETAIL` (on by default outside production) | The body is `{"status":"not_ready"}` and nothing else. The status code, 200 or 503, never changes either way | — |

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

## Deploying

Railway project with three services: this app, Postgres and Redis.
`railway.json` builds the Dockerfile, health-checks `/health/ready`, and runs
the migrations as the container starts, before the server listens; the new
version only takes traffic once it is healthy. Migrations are forward-only and
serialised by an advisory lock. Merging to `main` deploys.

- Production API: `https://splite-backend-production.up.railway.app`, moving to
  `https://api.splite.lat` (custom domain attached; DNS pending).
- `CORS_ORIGINS` must list every site origin that calls the API, including
  `https://splite.lat` once the site moves there.
- `DB_SSL=false` on Railway's private network, and `TRUST_PROXY=1`, or every
  client shares one rate-limit bucket.

Step-by-step setup, retention, reconciliation and scheduled maintenance:
[Deploying to Railway](docs/ARCHITECTURE.md#deploying-to-railway).
