const config = require('./config');
const { DETAILS } = require('./errors');

/**
 * OpenAPI 3.1 description of the API.
 *
 * This is a contract, not a brochure. `test/openapi.test.js` fails if a route
 * exists that is not described here, or if this describes a route that is not
 * mounted — which is how the tables router was found to be documented in the
 * README but absent from the app. It also enforces that every operation states
 * its authentication, its roles, and the error responses a client must handle.
 *
 * RBAC has no native OpenAPI representation, so required roles are carried in
 * `x-required-roles` and repeated in prose for humans.
 */

const { staff, parameters, responses } = require('./contract/common');
const { schemas } = require('./contract/schemas');
const { onboardingPaths } = require('./contract/paths/onboarding');
const healthPaths = require('./contract/paths/health');
const authPaths = require('./contract/paths/auth');
const guestPaths = require('./contract/paths/guest');
const tablesPaths = require('./contract/paths/tables');
const billsPaths = require('./contract/paths/bills');
const exchangeRatePaths = require('./contract/paths/exchangeRate');
const menuPaths = require('./contract/paths/menu');
const fiscalPaths = require('./contract/paths/fiscal');
const paymentsPaths = require('./contract/paths/payments');
const ordersPaths = require('./contract/paths/orders');
const webhooksPaths = require('./contract/paths/webhooks');
const accountPaths = require('./contract/paths/account');
const adminPaths = require('./contract/paths/admin');
const bankPaths = require('./contract/paths/bank');

/**
 * Las rutas, en el mismo orden de siempre. El documento se compara texto a
 * texto con `openapi.json`, así que cada archivo de `src/contract/paths/`
 * exporta sus trozos por nombre y aquí se vuelven a poner en fila: mover un
 * trozo de sitio cambia el documento aunque no cambie ninguna ruta.
 */
const paths = {
  ...healthPaths.core,
  ...authPaths.login,
  ...guestPaths.qr,
  ...tablesPaths.core,
  ...billsPaths.core,
  ...exchangeRatePaths.core,
  ...menuPaths.publicMenu,
  ...guestPaths.payments,
  ...fiscalPaths.invoices,
  ...guestPaths.bill,
  ...paymentsPaths.tips,
  ...ordersPaths.core,
  ...paymentsPaths.claims,
  ...guestPaths.banks,
  ...paymentsPaths.tips2,
  ...webhooksPaths.core,
  ...accountPaths.users,
  ...adminPaths.auth,
  ...accountPaths.subscription,
  ...adminPaths.notices,
  ...bankPaths.core,
  ...accountPaths.invitations,

  /**
   * Registration is described always, and served behind ONBOARDING_ENABLED.
   *
   * These were once spread in conditionally, so that the contract described
   * exactly what a given deployment answers. That was wrong for one decisive
   * reason: `openapi.json` is a *committed artifact*, and CI checks it byte for
   * byte with no `.env` present. A developer with the flag on in their `.env`
   * regenerates the file with these paths included, commits it, and every
   * subsequent CI run fails `openapi:check` on a file nobody can fix without
   * knowing about the flag.
   *
   * A published contract has to be a function of the code, not of the
   * environment that happened to serialise it. So the document is the whole
   * surface, `x-feature-flag` says which endpoints a deployment may not be
   * serving, and `test/openapi.test.js` knows to exempt them when the flag is
   * off.
   */
  ...onboardingPaths
};

const document = {
  openapi: '3.1.0',
  info: {
    title: 'Splite API',
    version: require('../package.json').version,
    description: [
      'Bill splitting for Venezuelan restaurants.',
      '',
      'Settlement is always VES in céntimos. USD and EUR are display references, never payment currencies.',
      '',
      '## Wire format conventions',
      '',
      'Every endpoint follows these rules. A frontend that trusts them never needs to guess.',
      '',
      '| Kind | JSON type | Format | Example |',
      '|------|-----------|--------|---------|',
      '| **Money** (minor units) | `string` | Digit string — no leading zeros except `"0"` | `"9007199254740993"` |',
      '| **FX rates** | `string` | Decimal, padded to 8 fractional digits | `"757.54060000"` |',
      '| **IDs** | `string` | UUID v4 | `"d290f1ee-6c54-4b01-90e6-d701748f0851"` |',
      '| **Timestamps** | `string` | ISO 8601 `date-time` | `"2025-03-05T16:30:00.000Z"` |',
      '| **Value dates** | `string` | ISO 8601 `date` | `"2025-03-06"` |',
      '',
      'Amounts are strings so values beyond 2^53 survive JSON (JavaScript `Number` loses',
      'precision past `Number.MAX_SAFE_INTEGER`). Rates are strings so every endpoint returns',
      'the same representation — no `757.5406` from one route and `"757.54060000"` from another.',
      '',
      'Every query is scoped to the caller\'s restaurant. A resource belonging to another tenant',
      'is reported as 404 rather than 403, so an endpoint never confirms that it exists.',
      '',
      '## Features that are off until configured',
      '',
      'Several capabilities cost money per call or reach a third party, so they are **opt-in per',
      'deployment**. A server without the setting refuses with a distinct 503 rather than failing',
      'oddly — but a 503 normally means "try later", and these do not. **`NOT_CONFIGURED` and',
      '`KEY_MISSING` mean stop offering the feature on this server**, not retry it. Nothing the',
      'caller does will change the answer.',
      '',
      '| Capability | Setting the server needs | Without it | Ask first |',
      '|---|---|---|---|',
      '| Read a menu from a photo or PDF | `MENU_OCR_API_KEY` | 503 `MENU_OCR_NOT_CONFIGURED` | `menuOcrAvailable` on `GET /api/v1/menu/settings` |',
      '| Enrol a second factor | `MFA_SECRET_KEYS` | 503 `MFA_KEY_MISSING`. Existing accounts keep signing in on passwords | `GET /api/v1/auth/mfa` |',
      '| Store bank API credentials | `PAYMENT_CREDENTIALS_KEYS` | 503 `PAYMENT_CREDENTIALS_KEY_MISSING` | — |',
      '| Charge a diner through Mercantil C2P | `MERCANTIL_C2P_URL`, **plus** credentials stored and proven per restaurant | 503 `PAYMENT_PROVIDER_MISCONFIGURED` | `chargeable` on `GET /api/v1/account/banks` |',
      '| Self-service restaurant signup | `ONBOARDING_ENABLED` and a mail provider | The routes are **not mounted at all**, so 404 | — |',
      '| Foreign-currency menu prices | `FX_ENABLED` (on by default) and a reachable BCV | 503 `FX_UNAVAILABLE`, after the stored-rate fallback is exhausted | `GET /api/v1/exchange-rate` |',
      '| Prometheus metrics at `/metrics` | `METRICS_TOKEN` | The route is **not mounted** — 404, not 401 | — |',
      '',
      'Declared Pago Móvil needs none of this and is the rail that works on a bare deployment: a',
      'diner declares a transfer, a member of staff confirms it against the bank app.',
      '',
      'Where a column above names something to ask, ask it — those endpoints answer from',
      'configuration and the answer does not change between requests. It is the difference between',
      'hiding a button and offering one that fails after the user has done the work.'
    ].join('\n'),
    'x-error-details': DETAILS,
    'x-wire-format': {
      money: { type: 'string', pattern: '^[0-9]+$', description: 'Integer minor units (céntimos) as a digit string.' },
      rate: { type: 'string', pattern: '^\\d+\\.\\d{8}$', description: 'Decimal rate padded to 8 fractional digits.' },
      id: { type: 'string', format: 'uuid', description: 'UUID v4.' },
      timestamp: { type: 'string', format: 'date-time', description: 'ISO 8601 date-time.' },
      valueDate: { type: 'string', format: 'date', description: 'ISO 8601 date (BCV publication date).' }
    }
  },
  servers: [
    { url: '/', description: 'This server' },
    { url: 'http://localhost:3000', description: 'Local development' }
  ],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Guest' },
    { name: 'Tables' },
    { name: 'Bills' },
    { name: 'Payments' },
    { name: 'Orders' },
    { name: 'Menu' },
    { name: 'Exchange rate' },
    { name: 'Webhooks' },
    { name: 'Account' },
    { name: 'Operator console', description: 'For Splite\'s own team, not restaurants: clients, plans, charges and payments. Separate sign-in with a mandatory second factor; see scripts/operator.js.' },
    { name: 'Bank connections', description: 'Bank movements from any bank — signed pushes or uploaded statements — checked against pending Pago Móvil claims.' },
    // Listed unconditionally even though its operations are only described when
    // ONBOARDING_ENABLED is on: a tag with no operations reads as a feature that
    // exists and is switched off, which is true, whereas a tag that appears and
    // disappears reads as two different APIs.
    { name: 'Onboarding' }
  ],
  security: staff,
  components: {
    securitySchemes: {
      staffAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Short-lived staff access token from /api/v1/auth/login.'
      },
      operatorAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Console session from /api/v1/admin/auth/login. Signed with a different key and audience from staff tokens; neither is accepted by the other\'s routes.'
      },
      guestAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Guest session token. Send the token as a bearer credential *and* the session id in the `X-Guest-Session` header; both are required. Obtained from POST /api/v1/guest/sessions by presenting a signed table QR.'
      }
    },
    parameters,
    schemas,
    responses
  },
  paths
};

module.exports = { document, enabled: config.docs.enabled };
