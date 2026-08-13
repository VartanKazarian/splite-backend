#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

/**
 * Mints a QR for every active table and writes a printable sheet.
 *
 *   QR_URL=https://your-api QR_EMAIL=you@example.com QR_PASSWORD='…' \
 *   QR_APP_URL=https://your-frontend npm run qr
 *
 * Goes through the API rather than the database on purpose: minting is
 * restricted to OWNER and MANAGER, is tenant-scoped, and writes a QR_ISSUED
 * audit entry. A script that reached into `tables` directly would skip all
 * three and produce codes nobody can account for.
 *
 * Each code encodes  <QR_APP_URL><QR_APP_PATH>?qr=<token>  — a *frontend* URL,
 * not an API one. Scanning it opens the guest app, which exchanges the token at
 * POST /api/v1/guest/sessions and then renders that table's bill.
 *
 * QR_APP_PATH defaults to /t and exists because the route belongs to whoever
 * builds the frontend. Set it to match, and mint before printing: the path is
 * inside the printed code and cannot be changed afterwards.
 *
 * Nothing about the token is secret: it names its restaurant and table in plain
 * base64url, and is useful only because it is signed.
 */

const API = (process.env.QR_URL || '').replace(/\/$/, '');
const EMAIL = process.env.QR_EMAIL;
const PASSWORD = process.env.QR_PASSWORD;
const APP = (process.env.QR_APP_URL || '').replace(/\/$/, '');
// The guest landing route in the frontend. Leading slash enforced so that
// QR_APP_PATH=t and QR_APP_PATH=/t produce the same code.
const APP_PATH = `/${(process.env.QR_APP_PATH || '/t').replace(/^\//, '')}`;
const OUT = process.env.QR_OUT || 'qr-codes.html';

if (!API || !EMAIL || !PASSWORD || !APP) {
  console.error([
    'QR_URL, QR_EMAIL, QR_PASSWORD and QR_APP_URL are required.',
    '',
    '  QR_URL      the API, e.g. https://splite-backend-production.up.railway.app',
    '  QR_APP_URL   the guest frontend, e.g. https://splite.lovable.app',
    '  QR_APP_PATH  its landing route, default /t'
  ].join('\n'));
  process.exit(2);
}

const escape = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function call(method, pathname, { body, token } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

/** Days until a token stops being accepted, read from the API's own answer. */
const days = seconds => Math.round(seconds / 86400);

async function main() {
  const login = await call('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (login.status !== 200) {
    console.error(`Login failed: ${login.body?.error?.code || login.status}`);
    process.exit(1);
  }
  const token = login.body.accessToken;

  const tables = await call('GET', '/api/v1/tables?limit=100&active=true', { token });
  if (tables.status !== 200) {
    console.error(`Could not list tables: ${tables.body?.error?.code || tables.status}`);
    process.exit(1);
  }
  const rows = tables.body.data || [];
  if (!rows.length) {
    console.error('No active tables. Create some first.');
    process.exit(1);
  }

  const cards = [];
  let ttlSeconds = null;

  for (const table of rows) {
    const qr = await call('GET', `/api/v1/guest/tables/${table.id}/qr`, { token });
    if (qr.status !== 200) {
      // A table that cannot be minted is reported rather than skipped silently:
      // a missing sticker is discovered by a diner, at the table.
      console.error(`  ${table.name}: ${qr.body?.error?.code || qr.status}`);
      continue;
    }
    ttlSeconds = qr.body.expiresIn;

    const url = `${APP}${APP_PATH}?qr=${encodeURIComponent(qr.body.token)}`;
    // Error correction M, so a code survives a smudge or a curled corner and
    // still scans from a table top.
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });

    cards.push(`
      <figure class="card">
        ${svg}
        <figcaption>
          <strong>${escape(table.name)}</strong>
          <span>Escanea para ver tu cuenta</span>
        </figcaption>
      </figure>`);
    console.log(`  minted ${table.name}`);
  }

  if (!cards.length) {
    console.error('Nothing minted.');
    process.exit(1);
  }

  // Null means permanent, which is the default: these go on furniture.
  const expiry = ttlSeconds
    ? `Estos códigos caducan en ${days(ttlSeconds)} días (${new Date(Date.now() + ttlSeconds * 1000).toISOString().slice(0, 10)}).`
    : 'Estos códigos no caducan.';

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Splite — códigos de mesa</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Helvetica Neue", system-ui, sans-serif; margin: 24px; color: #10201c; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.meta { font-size: 12px; color: #5f6f69; margin: 0 0 24px; }
  .sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
  .card { margin: 0; border: 1px solid #d3dad5; border-radius: 6px; padding: 16px; text-align: center; break-inside: avoid; }
  .card svg { width: 100%; height: auto; display: block; }
  figcaption { margin-top: 10px; display: flex; flex-direction: column; gap: 2px; }
  figcaption strong { font-size: 20px; letter-spacing: -0.01em; }
  figcaption span { font-size: 11px; color: #5f6f69; }
  @media print {
    body { margin: 0; }
    p.meta { display: none; }
    .card { border-color: #999; }
  }
</style>
<h1>Códigos de mesa</h1>
<p class="meta">${escape(expiry)} Generado ${new Date().toISOString().slice(0, 10)} · ${cards.length} mesas · ${escape(APP)}</p>
<div class="sheet">${cards.join('')}</div>
`;

  fs.writeFileSync(path.resolve(OUT), html);
  console.log(`\n${cards.length} codes written to ${OUT}`);
  if (ttlSeconds) {
    console.log(`These expire in ${days(ttlSeconds)} days, because QR_TTL_SECONDS is set on the API.`);
    console.log('Unset it to mint permanent codes before printing stickers.');
  } else {
    console.log('These do not expire. To revoke one, rotate that table\'s nonce:');
    console.log('  POST /api/v1/guest/tables/{tableId}/qr/rotate');
  }
  console.log(`Each encodes ${APP}${APP_PATH}?qr=… — that route must exist in the guest frontend.`);
  console.log('The path is inside the printed code, so confirm it before printing.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
