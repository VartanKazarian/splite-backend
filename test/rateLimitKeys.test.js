const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const config = require('../src/config');
const { redis } = require('../src/connectors/redis');
const rateLimit = require('../src/middleware/rateLimit');
const { staffSubject, credentialAttempt } = require('../src/middleware/rateLimitKeys');
const { signAccessToken, signRefreshToken } = require('../src/utils/tokens');

/**
 * Qué cuentan los limitadores que corren antes de autenticar.
 *
 * Lo que defienden estas pruebas: que un restaurante entero en el mismo wifi
 * no comparta cubo, y que abrir cubos nuevos no se pueda comprar inventándose
 * un token.
 */

const withAuth = (authorization, extra = {}) => ({
  ip: '198.51.100.7',
  get: name => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  ...extra
});

test('staffSubject cuenta al miembro del personal de un token válido', () => {
  const token = signAccessToken({ id: 'user-1', restaurantId: 'r-1', role: 'WAITER' });
  assert.equal(staffSubject(withAuth(`Bearer ${token}`)), 'user-1');
});

test('staffSubject no cuenta un token falsificado, de renovación o mal formado', () => {
  const forged = jwt.sign(
    { sub: 'attacker', type: 'access' },
    'not-the-secret',
    { issuer: config.jwt.issuer, audience: config.jwt.audience, algorithm: 'HS256' }
  );
  const refresh = signRefreshToken({ id: 'user-1', restaurantId: 'r-1', role: 'WAITER' }, 'jti-1');
  for (const header of [`Bearer ${forged}`, `Bearer ${refresh}`, 'Bearer nope', 'Basic abc', '', undefined]) {
    assert.equal(staffSubject(withAuth(header)), null, `contó ${String(header).slice(0, 20)}`);
  }
});

test('credentialAttempt deja fuera leer, renovar y cerrar la sesión', () => {
  for (const [method, path] of [
    ['GET', '/me'], ['PATCH', '/me'], ['GET', '/mfa'], ['POST', '/mfa/enrol'],
    ['POST', '/refresh'], ['POST', '/logout']
  ]) {
    assert.equal(credentialAttempt({ method, path, ip: '198.51.100.7' }), null, `${method} ${path}`);
  }
});

test('credentialAttempt sigue contando todo lo que adivina algo', () => {
  for (const [method, path] of [
    ['POST', '/login'], ['POST', '/login/mfa'], ['POST', '/password'],
    ['POST', '/mfa/confirm'], ['POST', '/mfa/disable'], ['POST', '/mfa/recovery-codes'],
    ['POST', '/invitations/preview'], ['POST', '/invitations/accept'],
    // Un método distinto sobre una ruta exenta no hereda la exención.
    ['DELETE', '/me'], ['POST', '/me']
  ]) {
    assert.equal(credentialAttempt({ method, path, ip: '198.51.100.7' }), '198.51.100.7', `${method} ${path}`);
  }
});

// -------------------------------------------------------------- composición

function fakeRedis() {
  const counts = new Map();
  redis.multi = () => {
    const ops = [];
    const chain = {
      incr(key) { ops.push(['incr', key]); return chain; },
      ttl(key) { ops.push(['ttl', key]); return chain; },
      async exec() {
        return ops.map(([op, key]) => {
          if (op === 'incr') { counts.set(key, (counts.get(key) || 0) + 1); return [null, counts.get(key)]; }
          return [null, 60];
        });
      }
    };
    return chain;
  };
  redis.expire = async () => 1;
  return counts;
}
const fakeRes = () => ({ headers: {}, set(k, v) { this.headers[k] = v; return this; } });
const originalMulti = redis.multi.bind(redis);
const originalExpire = redis.expire.bind(redis);
test.afterEach(() => { redis.multi = originalMulti; redis.expire = originalExpire; });

test('tres teléfonos leyendo la sesión desde el mismo wifi no gastan los intentos de acceso', async () => {
  const counts = fakeRedis();
  const auth = rateLimit({ windowSeconds: 60, max: 10, keyPrefix: 'auth', identify: credentialAttempt });
  for (let i = 0; i < 30; i += 1) {
    let err;
    await auth({ method: 'GET', path: '/me', ip: '198.51.100.7' }, fakeRes(), e => { err = e; });
    assert.equal(err, undefined, `la lectura ${i + 1} de /me fue rechazada`);
  }
  assert.equal(counts.size, 0, 'las lecturas de sesión no deberían contar');

  let last;
  for (let i = 0; i < 11; i += 1) {
    await auth({ method: 'POST', path: '/login', ip: '198.51.100.7' }, fakeRes(), e => { last = e; });
  }
  assert.equal(last?.code, 'RATE_LIMITED', 'el undécimo intento de acceso debería rechazarse');
});

test('el límite por personal separa a dos cuentas en la misma dirección', async () => {
  const counts = fakeRedis();
  const staff = rateLimit({ windowSeconds: 60, max: 3, keyPrefix: 'rl:staff', identify: staffSubject });
  const a = signAccessToken({ id: 'user-a', restaurantId: 'r-1', role: 'OWNER' });
  const b = signAccessToken({ id: 'user-b', restaurantId: 'r-1', role: 'WAITER' });

  let err;
  for (let i = 0; i < 4; i += 1) await staff(withAuth(`Bearer ${a}`), fakeRes(), e => { err = e; });
  assert.equal(err?.code, 'RATE_LIMITED', 'la cuarta petición de A debería rechazarse');

  let errB = 'unset';
  await staff(withAuth(`Bearer ${b}`), fakeRes(), e => { errB = e; });
  assert.equal(errB, undefined, 'B no comparte el cubo de A por venir de la misma IP');

  // Un token inventado no abre cubo propio: pasa de largo y vale el de dirección.
  await staff(withAuth('Bearer forged.token.here'), fakeRes(), () => {});
  assert.deepEqual([...counts.keys()].sort(), ['rl:staff:user-a', 'rl:staff:user-b']);
});
