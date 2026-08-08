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
- Payment concurrency control via `SELECT ... FOR UPDATE` and exact BigInt arithmetic
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
| GET | `/api/v1/bills/:id` | staff |
| POST | `/api/v1/bills/:id/payments` | staff (`OWNER`, `MANAGER`, `CASHIER`) |

Payments accept an `Idempotency-Key` header (or `idempotencyKey` in the body).
Retrying with the same key replays the stored response instead of charging twice.

## Migrations

Migrations live in `/migrations` and are applied in filename order by
`npm run migrate`, each in its own transaction, guarded by a Postgres advisory
lock so concurrent deploys cannot race.

`002_phase1_hardening.sql` adds a **globally unique staff email** index.
Deduplicate `users.email` across restaurants before applying it to a database
that already holds data.

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
