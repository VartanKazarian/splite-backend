const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * Qué cuenta `/health/ready` sobre la infraestructura, y a quién.
 *
 * El endpoint no pide credenciales y en Railway el dominio es público, así que
 * el cuerpo `{"postgres":"down","redis":"up"}` le dice a cualquiera qué pieza
 * está rota y cuándo volver a probar. El **código** de estado se queda igual --
 * 200 listo, 503 no listo -- porque es lo que consume el orquestador y lo que
 * decide si entra tráfico; lo que se retira es el desglose.
 *
 * Se prueba sobre `config` y no levantando el servidor porque lo que hay que
 * fijar es la regla por defecto, que depende de `NODE_ENV`, y eso se decide al
 * importar. Un proceso hijo por caso es la única forma honesta de leerlo dos
 * veces con entornos distintos.
 */
const read = (env) => {
  const out = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(require("./src/config").health.detail))'],
    {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://u:p@localhost:5432/d',
        REDIS_URL: 'redis://localhost:6379',
        JWT_ACCESS_SECRET: 'x'.repeat(40),
        JWT_REFRESH_SECRET: 'y'.repeat(40),
        QR_SIGNING_SECRET: 'z'.repeat(40),
        CORS_ORIGINS: 'https://example.com',
        ...env
      },
      encoding: 'utf8'
    }
  );
  return out === 'true';
};

test('production hides which dependency is down', () => {
  assert.equal(read({ NODE_ENV: 'production', HEALTH_DETAIL: '' }), false);
});

test('development keeps the breakdown, where it helps and costs nothing', () => {
  assert.equal(read({ NODE_ENV: 'development', HEALTH_DETAIL: '' }), true);
});

test('an operator can turn it back on in production, without a deploy', () => {
  assert.equal(read({ NODE_ENV: 'production', HEALTH_DETAIL: 'true' }), true);
});

test('and can turn it off outside production', () => {
  assert.equal(read({ NODE_ENV: 'development', HEALTH_DETAIL: 'false' }), false);
});
