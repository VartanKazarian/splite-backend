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
- USD shown as a display reference at a rate locked on first payment, never guessed
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

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/health/live` | none |
| GET | `/health/ready` | none |
| POST | `/api/v1/auth/login` | none |
| POST | `/api/v1/auth/refresh` | refresh token |
| POST | `/api/v1/auth/logout` | refresh token |
| POST | `/api/v1/guest/sessions` | signed QR token |
| GET | `/api/v1/guest/tables/:tableId/qr` | staff (`OWNER`, `MANAGER`) |
| POST | `/api/v1/guest/tables/:tableId/qr/rotate` | staff (`OWNER`, `MANAGER`) |
| GET | `/api/v1/tables` | staff |
| POST | `/api/v1/tables` | staff (`OWNER`, `MANAGER`) |
| PATCH | `/api/v1/tables/:tableId` | staff (`OWNER`, `MANAGER`) |
| GET | `/api/v1/bills` | staff |
| POST | `/api/v1/bills` | staff (`OWNER`, `MANAGER`, `CASHIER`, `WAITER`) |
| GET | `/api/v1/bills/:id` | staff |
| GET | `/api/v1/bills/:id/split?diners=n` | staff |
| POST | `/api/v1/bills/:id/void` | staff (`OWNER`, `MANAGER`) |
| POST | `/api/v1/bills/:id/payments` | staff (`OWNER`, `MANAGER`, `CASHIER`) |
| GET | `/api/v1/exchange-rate` | staff |

Payments accept an `Idempotency-Key` header (or `idempotencyKey` in the body).
Retrying with the same key replays the stored response instead of charging twice.

## Money model

Settlement is **always VES**, in céntimos, stored as `BIGINT`. USD is a display
reference only — it is never a payment currency. Migration 003 enforces this
with `CHECK (currency = 'VES')`; previously USD and USDT were accepted and
applied at face value against a bolívar balance.

The USD rate is **locked on the first payment against a bill** and reused for
every later split, so the figures on screen do not drift mid-meal. If no
verified rate is available the bill locks none, the USD line is omitted, and
**the payment still applies** — an FX outage is presentational, not financial.

Splits use largest-remainder allocation (`src/services/split.js`) so the parts
sum to exactly the total. Rounding each share independently would leave the last
diner unable to pay under `CHECK (amount_paid <= total_due)`, or leave the bill
permanently a few céntimos short of closing.

## Exchange rate

`GET /api/v1/exchange-rate` returns the official USD reference rate published by
the [Banco Central de Venezuela](https://www.bcv.org.ve/):

```json
{ "rate": 757.5406, "valueDate": "2026-08-10", "source": "BCV", "fetchedAt": "..." }
```

BCV publishes no API, so the rate is parsed from the `id="dolar"` block of their
home page (`src/connectors/bcv.js`) and cached for 15 minutes — their own
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

## Production notes

1. Use `DATABASE_URL` with TLS. Set `DB_SSL_REJECT_UNAUTHORIZED=true` once you pin your provider's CA.
2. Keep PostgreSQL and Redis on private networking; do not publish their ports.
3. Set `CORS_ORIGINS` to your exact frontend origins. Wildcards are rejected in production.
4. Set `TRUST_PROXY` to the number of proxy hops in front of the API, otherwise `req.ip` — and with it rate limiting and audit records — is attacker-controlled.
5. Run `npm run migrate` as a controlled deployment step, not on process boot.
6. Commit `package-lock.json`; the image build and CI both depend on it for reproducibility.

## Still open (Phase 2)

- Payment provider integration and reconciliation
- Webhook route wiring (`src/middleware/webhookSignature.js` is ready but unmounted)
- Guest-facing bill read/split endpoints on top of `authenticateGuest`
- Account lockout and MFA for staff logins
- Scheduled purge of expired `idempotency_keys` and `refresh_sessions`
- Integration tests against a live Postgres and Redis
