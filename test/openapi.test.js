const { test } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const { document } = require('../src/openapi');

/**
 * The spec is treated as a contract, so these tests fail when it and the app
 * disagree — in either direction. Documentation that is merely written by hand
 * drifts silently: the tables router was described in the README for several
 * commits while not being mounted at all, and nothing noticed.
 */

/** Every route Express will actually answer. */
function mountedRoutes() {
  const found = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          // Express writes params as :id; OpenAPI writes them as {id}.
          const path = (prefix + layer.route.path).replace(/\/$/, '') || '/';
          found.push(`${method.toUpperCase()} ${path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const mount = /^\^\\\/(.*?)\\\/\?\(\?=/.exec(layer.regexp.source);
        walk(layer.handle.stack, prefix + (mount ? '/' + mount[1].replace(/\\\//g, '/') : ''));
      }
    }
  };
  walk(app._router.stack, '');
  return found;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Every operation the spec describes. */
function documentedRoutes() {
  const found = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) found.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return found;
}

/** Documentation-only routes, which exist to describe the contract itself. */
const NOT_API_SURFACE = ['GET /openapi.json', 'GET /docs', 'GET /docs/{0}'];

const operations = () =>
  Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.includes(method))
      .map(([method, op]) => [`${method.toUpperCase()} ${path}`, op])
  );

test('every mounted route is described', () => {
  const undocumented = mountedRoutes()
    .filter(r => !NOT_API_SURFACE.some(skip => r.startsWith(skip)))
    .filter(r => !documentedRoutes().includes(r));

  assert.deepEqual(undocumented, [], 'routes exist that the contract does not mention');
});

test('every described route is mounted', () => {
  const mounted = mountedRoutes();
  const phantom = documentedRoutes().filter(r => !mounted.includes(r));

  // This is the direction that caught the unmounted tables router.
  assert.deepEqual(phantom, [], 'the contract promises routes the app does not serve');
});

test('every operation states whether it needs authentication', () => {
  for (const [name, op] of operations()) {
    assert.ok(Array.isArray(op.security), `${name} does not declare security`);
  }
});

test('an authenticated operation documents 401', () => {
  for (const [name, op] of operations()) {
    if (op.security.length === 0) continue;
    assert.ok(op.responses['401'], `${name} is authenticated but does not document 401`);
  }
});

test('a role-restricted operation documents 403 and names its roles', () => {
  for (const [name, op] of operations()) {
    if (!op['x-required-roles']) continue;
    assert.ok(Array.isArray(op['x-required-roles']) && op['x-required-roles'].length, `${name} has empty roles`);
    assert.ok(op.responses['403'], `${name} restricts by role but does not document 403`);
  }
});

test('every rate-limited operation documents 429 and 500', () => {
  for (const [name, op] of operations()) {
    // The health probes are mounted ahead of the rate limiter on purpose, so a
    // probe never consumes a client's budget and never fails because Redis is
    // down. 429 is unreachable for them, and asserting it would be documenting
    // a response the app cannot produce.
    if (name.includes('/health/')) {
      assert.ok(!op.responses['429'], `${name} sits ahead of the limiter and cannot return 429`);
      continue;
    }
    assert.ok(op.responses['500'], `${name} does not document 500`);
    assert.ok(op.responses['429'], `${name} is behind the rate limiter but does not document 429`);
  }
});

test('an operation taking a path parameter documents 404', () => {
  for (const [name, op] of operations()) {
    const hasPathParam = /\{[A-Za-z0-9_]+\}/.test(name);
    if (!hasPathParam) continue;
    assert.ok(op.responses['404'], `${name} takes a path parameter but does not document 404`);
  }
});

test('an operation with a request body documents 400', () => {
  for (const [name, op] of operations()) {
    if (!op.requestBody) continue;
    assert.ok(op.responses['400'], `${name} accepts a body but does not document 400`);
  }
});

test('the payments contract is complete', () => {
  // Called out explicitly because it is the one that moves money.
  const op = document.paths['/api/v1/bills/{id}/payments'].post;

  assert.deepEqual(op.security, [{ staffAuth: [] }]);
  assert.deepEqual(op['x-required-roles'], ['OWNER', 'MANAGER', 'CASHIER']);

  const idempotency = op.parameters.find(p => p.$ref?.endsWith('IdempotencyKey'));
  assert.ok(idempotency, 'Idempotency-Key is not part of the documented contract');

  assert.ok(op.requestBody.content['application/json'].schema.$ref.endsWith('PaymentRequest'));
  assert.ok(op.responses['200'].content['application/json'].schema.$ref.endsWith('PaymentResult'));

  for (const status of ['400', '401', '403', '404', '409', '429', '500']) {
    assert.ok(op.responses[status], `payments does not document ${status}`);
  }
});

test('settlement is documented as VES only', () => {
  assert.equal(document.components.schemas.PaymentRequest.properties.currency.const, 'VES');
  assert.equal(document.components.schemas.PaymentResult.properties.currency.const, 'VES');

  // A bill inherits the restaurant's menu currency, so the client does not
  // choose one; the settlement column is what carries VES.
  assert.equal(document.components.schemas.CreateBillRequest.properties.currency, undefined);
  assert.ok(document.components.schemas.Bill.properties.totalDueVes);
});

test('monetary amounts are documented as strings, not numbers', () => {
  // A JSON number has already lost precision past 2^53 by the time it arrives.
  for (const field of ['totalDue', 'totalDueVes', 'amountPaidVes', 'remainingVes']) {
    assert.equal(document.components.schemas.Bill.properties[field].type, 'string', `Bill.${field}`);
  }
  assert.equal(document.components.schemas.PaymentResult.properties.amountPaid.type, 'string');

  // The request side matters just as much: an integer here caps what can be
  // paid at 2^53 regardless of what the column holds.
  assert.equal(document.components.schemas.PaymentRequest.properties.amountMinorUnits.type, 'string');
});

test('every $ref resolves', () => {
  const seen = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') seen.push(value);
      else walk(value);
    }
  };
  walk(document);

  assert.ok(seen.length > 0, 'expected the document to use refs');
  for (const pointer of seen) {
    const resolved = pointer
      .replace(/^#\//, '')
      .split('/')
      .reduce((node, part) => (node == null ? undefined : node[part]), document);
    assert.ok(resolved, `unresolved $ref: ${pointer}`);
  }
});

test('every failure is the same envelope', () => {
  const { CODES } = require('../src/errors');
  const envelope = document.components.schemas.Error.properties.error;

  // `error` used to be a string on some routes and an object on others, so the
  // schema carried a oneOf and a client could not destructure a failure
  // without first knowing which route produced it.
  assert.equal(envelope.type, 'object', 'error must be an object, not a string or an array');
  assert.equal(document.components.schemas.Error.properties.error.oneOf, undefined,
    'a oneOf here means the client still has to branch on shape');

  assert.deepEqual(envelope.required, ['code', 'message', 'details', 'requestId'],
    'all four fields are always present, so none is optional to the client');

  // Codes are enumerated from the registry, so a client can switch
  // exhaustively and a generator can emit a union type.
  assert.deepEqual(envelope.properties.code.enum, Object.keys(CODES));
  assert.ok(envelope.properties.code.enum.length > 20, 'expected the full registry, not a sample');
});

test('the error codes a client branches on are published', () => {
  const { CODES, DETAILS } = require('../src/errors');
  assert.deepEqual(document.info['x-error-details'], DETAILS,
    'x-error-details must be the registry itself, not a hand-copied duplicate');

  const codes = document.components.schemas.Error.properties.error.properties.code.enum;
  for (const code of Object.keys(DETAILS)) {
    assert.ok(codes.includes(code), `${code} documents details but is not a published code`);
  }
  assert.equal(codes.length, Object.keys(CODES).length);
});

test('no operation documents an error status the envelope cannot express', () => {
  // Every error response must point at Error or ValidationError. A route that
  // invents its own error schema is how the four shapes appeared originally.
  const offenders = [];
  for (const [name, op] of operations()) {
    for (const [status, res] of Object.entries(op.responses)) {
      if (Number(status) < 400) continue;
      const schema = res.content?.['application/json']?.schema;
      if (!schema) continue; // a $ref to a shared response, checked below
      const target = schema.$ref || '';
      if (!target.endsWith('/Error') && !target.endsWith('/ValidationError')) {
        offenders.push(`${name} ${status}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'these responses do not use the standard error envelope');
});

test('every shared error response uses the envelope', () => {
  for (const [name, res] of Object.entries(document.components.responses)) {
    const schema = res.content?.['application/json']?.schema;
    assert.ok(schema, `${name} has no schema`);
    const target = schema.$ref || '';
    assert.ok(
      target.endsWith('/Error') || target.endsWith('/ValidationError'),
      `${name} does not use the standard error envelope`
    );
  }
});

test('every documented field is camelCase', () => {
  // PostgreSQL is snake_case and the public API is camelCase, and src/dto.js is
  // the only place allowed to cross between them. Before that boundary existed
  // the API spoke three conventions at once: raw rows from bills, SQL aliases
  // from menu, hand-built objects from payments — a single Bill carried
  // `total_due_ves` and `usdReference` side by side. This fails if any of that
  // comes back.
  const offenders = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const field of Object.keys(value)) {
          if (field.includes('_')) offenders.push(`${path}.${field}`);
        }
      }
      walk(value, `${path}.${key}`);
    }
  };
  walk(document.components.schemas, 'schemas');
  walk(document.paths, 'paths');

  assert.deepEqual(offenders, [], 'these fields leak the database naming convention onto the wire');
});

test('a date-only field is not documented as a timestamp', () => {
  // node-pg parses a DATE column into a JS Date at local midnight, so the
  // default serialisation carries a zone offset: "2025-03-06T04:00:00.000Z"
  // here, "...T00:00:00.000Z" on a UTC host. A client formatting that locally
  // can land a day early, and for a BCV value date that selects a different
  // published rate.
  const valueDate = document.components.schemas.Bill.properties.fxValueDate;
  assert.equal(valueDate.format, 'date', 'fxValueDate is a calendar date, not an instant');

  const rateValueDate = document.components.schemas.ExchangeRate
    .properties.rates.additionalProperties.properties.valueDate;
  assert.equal(rateValueDate.format, 'date');
});

test('the wire-format conventions are declared and enforced', () => {
  const wf = document.info['x-wire-format'];
  assert.ok(wf, 'x-wire-format extension is missing');
  for (const key of ['money', 'rate', 'id', 'timestamp', 'valueDate']) {
    assert.ok(wf[key], `x-wire-format.${key} is missing`);
  }

  const rateFields = [
    ['Bill', 'fxRateVesPerUnit'],
    ['PaymentResult', 'fxRate'],
  ];
  for (const [schema, field] of rateFields) {
    const prop = document.components.schemas[schema].properties[field];
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    assert.ok(types.includes('string'), `${schema}.${field} must be a string, got ${prop.type}`);
    assert.ok(prop.pattern, `${schema}.${field} needs a pattern to enforce the padded format`);
  }

  const exchangeRateProp = document.components.schemas.ExchangeRate
    .properties.rates.additionalProperties.properties.rate;
  assert.equal(exchangeRateProp.type, 'string', 'ExchangeRate.rate must be a string');
  assert.ok(exchangeRateProp.pattern, 'ExchangeRate.rate needs a pattern');
});

test('the README does not claim a mounted feature is missing', () => {
  // This has gone wrong twice. The README claimed "No payments ledger" after
  // migration 007 shipped one, and then listed bill line items, the split
  // engine and guest bill reads as unbuilt after all three were mounted.
  // Every other contract here has a drift test; prose had none.
  //
  // Matched on claims of *absence* rather than on capability names, because
  // Open points legitimately mentions things that exist in order to explain
  // what does not -- "the split engine is advisory" is true and must not trip
  // this. A broader README-versus-code check would fail on ordinary prose
  // edits and end up disabled, which is worse than not having one.
  const fs = require('node:fs');
  const readme = fs.readFileSync(require('node:path').join(__dirname, '..', 'README.md'), 'utf8');

  const ABSENCE_CLAIMS = [
    [/no bill line items/i, '/api/v1/bills/{id}/items'],
    [/no payments? ledger/i, '/api/v1/bills/{id}/payments'],
    [/no split engine/i, '/api/v1/bills/{id}/split/preview'],
    [/guest loop dead-ends/i, '/api/v1/guest/bill'],
    [/authenticateGuest[^.]*mounted on no route/i, '/api/v1/guest/bill'],
    [/guest-facing bill read[^.]*never mounted/i, '/api/v1/guest/bill']
  ];

  const stale = ABSENCE_CLAIMS
    .filter(([pattern, path]) => pattern.test(readme) && document.paths[path])
    .map(([pattern]) => String(pattern));

  assert.deepEqual(stale, [], 'the README claims these are missing while the routes are mounted');
});

test('the document has the structure an OpenAPI 3.1 consumer expects', () => {
  assert.equal(document.openapi, '3.1.0');
  assert.ok(document.info.title);
  assert.ok(document.info.version, 'version is required and drives client generation');
  assert.ok(document.components.securitySchemes.staffAuth);

  for (const [name, op] of operations()) {
    assert.ok(op.summary, `${name} has no summary`);
    assert.ok(op.responses && Object.keys(op.responses).length, `${name} documents no responses`);
    for (const [status, res] of Object.entries(op.responses)) {
      const isRef = Boolean(res.$ref);
      assert.ok(isRef || res.description, `${name} ${status} has neither $ref nor description`);
    }
  }
});
