const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const app = require('../../src/app');

/**
 * A quién se le factura, sobre HTTP.
 *
 * Cambiar esto no es editar un perfil: decide cómo declara el restaurante. Así
 * que lo que se comprueba aquí es sobre todo quién puede tocarlo y qué pasa con
 * lo que no se menciona en el cuerpo.
 */
describe('política de facturación sobre HTTP', { skip }, () => {
  let server, base, restaurant, ownerToken, managerToken;

  const request = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1', 'auth:::ffff:127.0.0.1', 'auth:127.0.0.1'
  );
  beforeEach(clearIpRateLimits);

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Policy Tenant' });

    const mint = async (role) => {
      const { rows } = await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role)
         VALUES ($1, $2, 'x', $3) RETURNING id`,
        [restaurant.id, `${role.toLowerCase()}-${restaurant.id}@example.com`, role]
      );
      return signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role });
    };
    ownerToken = await mint('OWNER');
    managerToken = await mint('MANAGER');

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  it('por defecto se factura a cada comensal', async () => {
    const res = await request('GET', '/api/v1/account', null, ownerToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.fiscalInvoicePolicy, 'PER_DINER');
  });

  it('el dueño puede pasar a factura única de mesa, y se lee al releer', async () => {
    const patched = await request('PATCH', '/api/v1/account',
      { fiscalInvoicePolicy: 'SINGLE_BILL' }, ownerToken);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.fiscalInvoicePolicy, 'SINGLE_BILL');

    const reread = await request('GET', '/api/v1/account', null, ownerToken);
    assert.equal(reread.body.fiscalInvoicePolicy, 'SINGLE_BILL', 'y quedó guardado, no sólo devuelto');

    await request('PATCH', '/api/v1/account', { fiscalInvoicePolicy: 'PER_DINER' }, ownerToken);
  });

  it('un encargado no puede cambiarla', async () => {
    // No es edición de perfil: decide cómo se declara. Va con las decisiones de
    // dinero, que son del dueño.
    const res = await request('PATCH', '/api/v1/account',
      { fiscalInvoicePolicy: 'SINGLE_BILL' }, managerToken);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');

    const reread = await request('GET', '/api/v1/account', null, ownerToken);
    assert.equal(reread.body.fiscalInvoicePolicy, 'PER_DINER', 'y no cambió nada');
  });

  it('un encargado sí puede seguir renombrando', async () => {
    // El 403 tiene que ser del campo, no de la ruta: si el encargado perdiera
    // el renombrado, esto habría roto algo que ya funcionaba.
    const res = await request('PATCH', '/api/v1/account', { name: 'Renombrado' }, managerToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'Renombrado');
  });

  it('cambiar la política no renombra el restaurante', async () => {
    /*
     * La razón de que `name` dejara de ser obligatorio.
     *
     * Si el cuerpo exigiera el nombre, cambiar la política obligaría a
     * reenviarlo -- y un cliente que mandara el suyo en caché renombraría el
     * restaurante sin querer, delante de cada comensal que escanee el QR.
     */
    await request('PATCH', '/api/v1/account', { name: 'Casa 72' }, ownerToken);
    const res = await request('PATCH', '/api/v1/account',
      { fiscalInvoicePolicy: 'SINGLE_BILL' }, ownerToken);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'Casa 72', 'el nombre no se toca al no mencionarlo');
    await request('PATCH', '/api/v1/account', { fiscalInvoicePolicy: 'PER_DINER' }, ownerToken);
  });

  it('un cuerpo vacío o una política inventada se rechazan', async () => {
    const empty = await request('PATCH', '/api/v1/account', {}, ownerToken);
    assert.equal(empty.status, 400, 'un PATCH que no pide nada es un error del cliente');

    const bogus = await request('PATCH', '/api/v1/account',
      { fiscalInvoicePolicy: 'A_VECES' }, ownerToken);
    assert.equal(bogus.status, 400);
    assert.ok(bogus.body.error.details.fieldPaths.includes('fiscalInvoicePolicy'));
  });

  /**
   * El domicilio del local, que es lo que encabeza el recibo.
   *
   * Lo que importa aquí es el tercer estado. Ausente deja lo que hay, texto lo
   * cambia y cadena vacía lo borra: sin ese último caso una dirección mal
   * escrita se quedaría para siempre, porque no habría forma de quitarla.
   */
  it('el domicilio se pone, se conserva y se puede borrar', async () => {
    const set = await request('PATCH', '/api/v1/account',
      { fiscalAddress: 'Av. Francisco de Miranda, Chacao, Caracas' }, ownerToken);
    assert.equal(set.status, 200);
    assert.equal(set.body.fiscalAddress, 'Av. Francisco de Miranda, Chacao, Caracas');

    // Un cuerpo que no lo menciona no lo toca. Sin esto, renombrar el local
    // borraría su dirección.
    const rename = await request('PATCH', '/api/v1/account', { name: 'Policy Tenant' }, ownerToken);
    assert.equal(rename.status, 200);
    assert.equal(rename.body.fiscalAddress, 'Av. Francisco de Miranda, Chacao, Caracas');

    const cleared = await request('PATCH', '/api/v1/account', { fiscalAddress: '' }, ownerToken);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.fiscalAddress, null);

    // Y la lectura coincide con lo que devolvió la escritura.
    const read = await request('GET', '/api/v1/account', null, ownerToken);
    assert.equal(read.body.fiscalAddress, null);
  });

  /**
   * El correo al que responden los clientes a su factura (Reply-To).
   *
   * Los mismos tres estados que el domicilio, y una cosa más: tiene que ser un
   * correo. Uno mal escrito haría que cada respuesta rebotara.
   */
  it('el correo de contacto se pone, se conserva, se borra y tiene que ser un correo', async () => {
    const set = await request('PATCH', '/api/v1/account',
      { contactEmail: 'Facturas@Casa72.com' }, ownerToken);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.contactEmail, 'facturas@casa72.com', 'en minúsculas');

    const rename = await request('PATCH', '/api/v1/account', { name: 'Policy Tenant' }, ownerToken);
    assert.equal(rename.body.contactEmail, 'facturas@casa72.com');

    const bad = await request('PATCH', '/api/v1/account', { contactEmail: 'no es un correo' }, ownerToken);
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.details.fieldPaths.includes('contactEmail'));

    const cleared = await request('PATCH', '/api/v1/account', { contactEmail: '' }, ownerToken);
    assert.equal(cleared.body.contactEmail, null);
    const read = await request('GET', '/api/v1/account', null, ownerToken);
    assert.equal(read.body.contactEmail, null);
  });

  it('el domicilio no es una decisión de dueño: un encargado puede corregirlo', async () => {
    // A diferencia de la política de facturación. Una dirección mal escrita la
    // ve cada comensal en su recibo, y esperar al dueño para arreglarla no
    // protege nada.
    const res = await request('PATCH', '/api/v1/account', { fiscalAddress: 'Calle 5, Mérida' }, managerToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.fiscalAddress, 'Calle 5, Mérida');
  });
});
