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
  const payment = document.components.schemas.PaymentRequest;
  assert.equal(payment.properties.currency.const, 'VES');
  assert.equal(document.components.schemas.CreateBillRequest.properties.currency.const, 'VES');
});

test('monetary amounts are documented as strings, not numbers', () => {
  // A JSON number has already lost precision past 2^53 by the time it arrives.
  for (const field of ['total_due', 'amount_paid', 'remaining']) {
    assert.equal(document.components.schemas.Bill.properties[field].type, 'string', `Bill.${field}`);
  }
  assert.equal(document.components.schemas.PaymentResult.properties.amountPaid.type, 'string');
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
