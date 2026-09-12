const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const { redis, closeRedis } = require('../../src/connectors/redis');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const {
  createGuestSession, resolveGuestSession, destroyGuestSession
} = require('../../src/services/guest');
const config = require('../../src/config');

/**
 * Guest sessions against a real Redis and a real Postgres.
 *
 * Two halves, and they are stored in different places on purpose. Redis keeps
 * the idle timer, which slides on every request and decides whether a diner who
 * sat down at eight can still pay at half past ten. Postgres keeps who the
 * session is, when it must die whatever happens, and whether somebody ended it.
 *
 * The unit suite proves `expire` is called and that the fallback is wired. This
 * proves Redis honours the TTL, that the row outlives the cache, and that a
 * flush -- the thing that used to sign out a whole dining room -- does not.
 */
describe('guest sessions', { skip }, () => {
  let restaurant;
  let table;
  let seq = 0;
  const created = [];

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Guest Session Tenant' });
    table = await fixtures.createTable(restaurant.id, { name: `G${++seq}` });
  });

  after(async () => {
    if (created.length) await redis.del(...created);
    await db.query('DELETE FROM guest_sessions WHERE restaurant_id = $1', [restaurant?.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  const newSession = async () => {
    const session = await createGuestSession({ restaurantId: restaurant.id, tableId: table.id });
    created.push(`guest:session:${session.sessionId}`);
    return session;
  };

  it('renews the real TTL on every use', async () => {
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;

    // Age the key the way two hours of dinner would.
    await redis.expire(key, 30);
    assert.ok((await redis.ttl(key)) <= 30);

    assert.ok(await resolveGuestSession(session.sessionId, session.guestToken));

    const ttl = await redis.ttl(key);
    assert.ok(ttl > 30, `expected a renewed TTL, got ${ttl}`);
    assert.ok(ttl <= config.guest.sessionTtlSeconds);
  });

  it('does not renew for a token that does not match', async () => {
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;
    await redis.expire(key, 30);

    assert.equal(await resolveGuestSession(session.sessionId, 'wrong-token'), null);
    assert.ok((await redis.ttl(key)) <= 30, 'a failed attempt must not extend the credential');
  });

  it('survives the cache being flushed out from under it', async () => {
    // The failure this exists to prevent. Redis was the only record, so a
    // restart or an eviction signed out every diner in every restaurant -- and
    // they could not recover, because the client strips the QR token out of the
    // URL once it has been exchanged. Somebody had to rescan the sticker in the
    // middle of paying.
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;

    await redis.del(key);
    assert.equal(await redis.get(key), null, 'the cache really is empty');

    const resolved = await resolveGuestSession(session.sessionId, session.guestToken);
    assert.ok(resolved, 'the diner is still signed in');
    assert.equal(resolved.restaurantId, restaurant.id);
    assert.equal(resolved.tableId, table.id);

    // Warmed on the way through, so an outage costs one query per session
    // rather than one per request.
    assert.ok(await redis.get(key), 'and the cache is repopulated');
  });

  it('drops a session that has passed the absolute ceiling', async () => {
    // The cap is a column now, not a date carried in the cache entry, so this
    // is what actually enforces it.
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;

    await db.query(
      "UPDATE guest_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [session.sessionId]
    );
    await redis.del(key);

    assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
  });

  /*
   * Aquí vivía una prueba llamada «a cached entry cannot outlive the ceiling by
   * more than the idle timeout» cuyo cuerpo entero era
   * `assert.ok(sessionTtlSeconds < maxSessionAgeSeconds)`: comprobaba que 2 < 12
   * y nada más. No creaba sesión, no tocaba la caché y no llamaba al resolutor,
   * así que no podía fallar -- y lo que afirmaba su nombre era falso. El
   * deslizamiento reiniciaba el TTL entero en cada petición, de modo que una
   * sesión usada cada menos de dos horas nunca perdía su entrada, y el camino
   * de caché devuelve sin consultar Postgres.
   *
   * Las cinco que siguen son las que sí lo demuestran. El reloj se mueve
   * escribiendo topes en el pasado o en el futuro, no esperando.
   */

  /** Deja la entrada de caché con el tope que se le diga, sin tocar la fila. */
  const forgeCap = async (sessionId, absoluteExpiresAt, ttl) => {
    const key = `guest:session:${sessionId}`;
    const raw = JSON.parse(await redis.get(key));
    raw.absoluteExpiresAt = absoluteExpiresAt;
    await redis.set(key, JSON.stringify(raw), 'EX', ttl);
  };

  it('A · la sesión sigue viva y el ocio sigue deslizando dentro del tope', async () => {
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;
    await redis.expire(key, 60);
    assert.equal(await redis.ttl(key), 60);

    const resolved = await resolveGuestSession(session.sessionId, session.guestToken);
    assert.equal(resolved.restaurantId, restaurant.id);
    // Vuelve a subir hacia el ocio completo, porque el tope está lejos.
    assert.ok(await redis.ttl(key) > 60);
  });

  it('B · pasado el tope se rechaza, se borra la entrada y no resucita', async () => {
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;
    // El tope ya pasó, pero la entrada sigue viva: es exactamente el estado que
    // producía el fallo.
    await forgeCap(session.sessionId, Date.now() - 1000, 3600);

    assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
    assert.equal(await redis.get(key), null, 'la entrada tiene que quedar borrada');
    // Y no vuelve: el siguiente intento cae a Postgres, cuya fila también venció.
    await db.query(
      'UPDATE guest_sessions SET expires_at = NOW() - INTERVAL \'1 minute\' WHERE id = $1',
      [session.sessionId]
    );
    assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
  });

  it('C · deslizar no puede pasarse del tope: 30 minutos, no 2 horas', async () => {
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;
    const treintaMin = 30 * 60;
    await forgeCap(session.sessionId, Date.now() + treintaMin * 1000, 3600);

    assert.ok(await resolveGuestSession(session.sessionId, session.guestToken));

    const ttl = await redis.ttl(key);
    assert.ok(ttl <= treintaMin, `el TTL quedó en ${ttl}, por encima de lo que queda de tope`);
    assert.ok(ttl > treintaMin - 60, `el TTL quedó en ${ttl}, demasiado corto`);
    assert.ok(ttl < config.guest.sessionTtlSeconds, 'no puede ser el ocio entero');
  });

  it('D · la actividad continua no mantiene viva la sesión más allá del tope', async () => {
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;
    // Doce peticiones seguidas, como un comensal que usa el teléfono toda la
    // noche. El tope se acerca a cada vuelta y el TTL tiene que seguirlo hacia
    // abajo, no rebotar al ocio completo.
    let anterior = Infinity;
    for (let i = 10; i >= 1; i--) {
      await forgeCap(session.sessionId, Date.now() + i * 60 * 1000, 3600);
      assert.ok(await resolveGuestSession(session.sessionId, session.guestToken),
        `la vuelta ${i} debería seguir siendo válida`);
      const ttl = await redis.ttl(key);
      assert.ok(ttl <= i * 60, `vuelta ${i}: TTL ${ttl} por encima del tope restante`);
      assert.ok(ttl < anterior, 'el TTL tiene que ir bajando, no rebotar');
      anterior = ttl;
    }
    // Y la vuelta de después del tope ya no pasa, por muy seguida que venga.
    await forgeCap(session.sessionId, Date.now() - 1, 3600);
    assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
  });

  it('E · el tope se aplica en el camino de caché, sin consultar Postgres', async () => {
    const session = await newSession();
    await forgeCap(session.sessionId, Date.now() - 1000, 3600);

    // La prueba de fondo: si el rechazo dependiera de la fila, bastaría con
    // dejar la fila sana para que la sesión siguiera pasando. Se deja sana **y
    // se cuentan las consultas**: tienen que ser cero.
    await db.query(
      'UPDATE guest_sessions SET expires_at = NOW() + INTERVAL \'6 hours\' WHERE id = $1',
      [session.sessionId]
    );
    const real = db.query;
    let consultas = 0;
    db.query = (...args) => { consultas++; return real.apply(db, args); };
    try {
      assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null,
        'el tope de la entrada manda aunque la fila diga que queda vida');
    } finally {
      db.query = real;
    }
    assert.equal(consultas, 0, 'el camino de caché no debe consultar Postgres');
  });

  it('stays revoked when the cache is flushed', async () => {
    // Deleting the cache entry alone would let a flush resurrect a session
    // somebody deliberately ended, by re-reading a row that never said so.
    const session = await newSession();
    await destroyGuestSession(session.sessionId);
    await redis.del(`guest:session:${session.sessionId}`);

    assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);

    const { rows } = await db.query(
      'SELECT revoked_at FROM guest_sessions WHERE id = $1', [session.sessionId]
    );
    assert.ok(rows[0].revoked_at, 'and the row says so');
  });

  it('never stores the token itself, in either place', async () => {
    const session = await newSession();

    const cached = await redis.get(`guest:session:${session.sessionId}`);
    assert.equal(cached.includes(session.guestToken), false);

    const { rows } = await db.query(
      'SELECT token_hash FROM guest_sessions WHERE id = $1', [session.sessionId]
    );
    assert.equal(rows[0].token_hash.length, 64);
    assert.equal(rows[0].token_hash.includes(session.guestToken), false);
  });

  it('refuses a session for a table in another restaurant', async () => {
    // The composite foreign key, doing the job it was added for: a session is
    // scoped to a table *of that restaurant*, and the pairing is checked by the
    // database rather than trusted from the caller.
    const other = await fixtures.createRestaurant({ name: 'Other Guest Tenant' });
    try {
      await assert.rejects(
        () => createGuestSession({ restaurantId: other.id, tableId: table.id }),
        /guest_sessions_table_fk|foreign key/i
      );
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });
});
