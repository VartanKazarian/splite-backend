const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const splitEngine = require('./splitEngine');
const { logAudit } = require('./audit');

/**
 * Persistent bill splits.
 *
 * A split is created *from* the advisory engine, not instead of it: the engine
 * still decides who owes what, and this stores that decision so a group can
 * agree it once and pay against it from several phones. The engine's exactness
 * guarantee (shares sum to the outstanding balance) becomes a database
 * guarantee here (migration 020), so a split that does not add up cannot exist.
 *
 * The plan is frozen at its basis -- the outstanding balance the moment it was
 * agreed. It does not move as the bill is paid, which is what lets a share be
 * paid down independently while bills.amount_paid_ves goes on meaning the same
 * thing it always did: the total actually settled, from any source.
 */

const PARTICIPANT_COLUMNS = `id, ext_ref, name, amount_ves, amount_paid_ves`;

/**
 * Creates and stores a split from a validated split request.
 *
 * The allocation is computed by the same engine the preview endpoint uses, so a
 * persisted split and a preview of the same request are never different
 * numbers. Then the split, its participants and (for ITEMS) its claims are
 * written in one transaction -- the deferred sum constraint checks the shares
 * against the basis at commit, whole.
 */
async function createSplit({ restaurantId, bill, items, request, createdBy }) {
  // The bill has to be OPEN, checked here rather than in each route for the
  // same reason the payment rules live in `applyToBill`: this is the one point
  // every caller passes through, and a rule stated in two places is a rule that
  // will eventually be stated differently.
  //
  // A split of a VOID bill is a plan nobody can settle. The shares compute
  // perfectly, the table can read them off a screen and agree to them, and then
  // every payment against them is refused by `applyToBill` with BILL_NOT_OPEN
  // -- the failure surfacing at the till, one diner at a time, long after the
  // group thought the question was settled.
  //
  // CLOSED was already refused, but only incidentally: a fully paid bill has
  // nothing outstanding, so the engine rejected the basis rather than the
  // status. That is the right answer reached by an argument that does not
  // mention the bill's state, and it would stop holding the moment any status
  // other than OPEN could carry a balance.
  if (bill.status !== 'OPEN') {
    throw new ApiError('BILL_NOT_OPEN', 'A split can only be agreed on an open bill', {
      status: bill.status ?? null
    });
  }

  // Compute first, outside the transaction: an invalid request (shares that do
  // not add up, an unclaimed line, an unknown participant) is the engine's to
  // reject, with the specific error, before anything is written.
  const allocation = splitEngine.preview({ bill, items, request });

  // Map the client's participant label -> the row we are about to create, so an
  // ITEMS claim can be recorded against the persisted participant id.
  const byExtRef = new Map();

  let superseded = null;

  try {
    const created = await db.withTransaction(async client => {
      /*
       * Un reparto que nadie ha pagado no ata a nadie.
       *
       * Antes, el primero que dividía dejaba la cuenta cerrada para los demás:
       * el índice parcial devolvía SPLIT_ALREADY_EXISTS y anularlo sólo estaba
       * en las rutas del personal, así que si esa persona se iba sin pagar, el
       * resto de la mesa necesitaba un mesero para poder repartir de otra
       * forma. La propuesta de uno se comportaba como un acuerdo de todos.
       *
       * Así que se reemplaza. El servidor ya creía esta regla -- `voidSplit`
       * lleva desde siempre negándose cuando hay dinero detrás --; lo que
       * faltaba era que el comensal pudiera alcanzarla.
       *
       * Dentro de la misma transacción y con el viejo bloqueado: si se anulara
       * aparte y la escritura del nuevo fallara, la mesa se quedaría sin
       * ninguno. Y si hay dinero contra el viejo, `discardUnpaidSplit` lo
       * impide y no se crea nada -- que es lo correcto: ahí ya no es una
       * propuesta.
       */
      const live = (await client.query(
        `SELECT id FROM bill_splits
          WHERE restaurant_id = $1 AND bill_id = $2 AND status = 'ACTIVE'
          FOR UPDATE`,
        [restaurantId, bill.id]
      )).rows[0];

      if (live) {
        await discardUnpaidSplit(client, {
          restaurantId, billId: bill.id, splitId: live.id
        });
        superseded = live.id;
      }

      const splitRow = (await client.query(
        `INSERT INTO bill_splits (restaurant_id, bill_id, mode, basis_ves, created_by_type, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, mode, basis_ves, status, created_at`,
        [restaurantId, bill.id, request.mode, allocation.outstandingVes, createdBy.type, createdBy.id]
      )).rows[0];

      for (const share of allocation.allocations) {
        const participant = (await client.query(
          `INSERT INTO bill_split_participants (restaurant_id, split_id, ext_ref, name, amount_ves)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, ext_ref`,
          [restaurantId, splitRow.id, share.participantId, share.name, share.amountVes]
        )).rows[0];
        byExtRef.set(participant.ext_ref, participant.id);
      }

      // ITEMS: record who is on which line, translated from the request's
      // participant labels to the persisted participant ids.
      //
      // A line may now be claimed by units -- two of three beers to Ana, one to
      // Luis -- which means the same person can appear on one line in more than
      // one claim. The table holds one row per (line, participant), so those
      // are the same row and the second insert would otherwise collide with
      // `bill_split_items_unique` and surface as a 500. The exact money is in
      // `bill_split_participants`, computed per unit by the engine and enforced
      // by the split's own sum constraint; these rows say who is on the line,
      // and saying it twice adds nothing.
      if (request.mode === 'ITEMS') {
        for (const claim of request.claims ?? []) {
          for (const extRef of claim.participantIds) {
            await client.query(
              `INSERT INTO bill_split_items (restaurant_id, split_id, bill_item_id, participant_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT ON CONSTRAINT bill_split_items_unique DO NOTHING`,
              [restaurantId, splitRow.id, claim.itemId, byExtRef.get(extRef)]
            );
          }
        }
      }

      return splitRow.id;
    }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });

    await logAudit({
      restaurantId,
      actorId: createdBy.id,
      action: 'BILL_SPLIT_CREATED',
      resourceType: 'bill',
      resourceId: bill.id,
      details: {
        splitId: created, mode: request.mode, basisVes: allocation.outstandingVes,
        // Cuál reemplazó, si reemplazó alguno: sin esto, en el registro parece
        // que un reparto se desvaneció y otro apareció sin relación.
        ...(superseded ? { supersededSplitId: superseded } : {})
      }
    });

    if (superseded) {
      await logAudit({
        restaurantId,
        actorId: createdBy.id,
        action: 'BILL_SPLIT_VOIDED',
        resourceType: 'bill_split',
        resourceId: superseded,
        details: { supersededBySplitId: created }
      });
    }

    return getSplit({ restaurantId, splitId: created, bill });
  } catch (err) {
    // The partial unique index: a live split already exists on this bill.
    if (err.code === '23505' && String(err.constraint || '').includes('one_active_per_bill')) {
      throw new ApiError(
        'SPLIT_ALREADY_EXISTS',
        'This bill already has an active split; void it before creating another'
      );
    }
    throw err;
  }
}

/** A split with its participants and, for ITEMS, its claims. */
async function getSplit({ restaurantId, splitId, bill = null }) {
  const split = (await db.query(
    `SELECT id, bill_id, mode, basis_ves, status, created_by_type, created_at, updated_at
       FROM bill_splits WHERE id = $1 AND restaurant_id = $2`,
    [splitId, restaurantId]
  )).rows[0];
  if (!split) throw new ApiError('SPLIT_NOT_FOUND', 'Split not found');

  // `created_at` alone is not an order. Every participant of a split is inserted
  // in one transaction and the column defaults to NOW(), which in Postgres is
  // the *transaction* timestamp -- so all of them carry the same instant and the
  // sort falls back to whatever order the heap returns. Two reads of one split
  // could list its participants differently, which is a shuffled screen for a
  // client and a coin flip for any caller indexing into the array. `ext_ref` is
  // the label the client chose and is unique within a split, so it breaks the
  // tie deterministically.
  const participants = (await db.query(
    `SELECT ${PARTICIPANT_COLUMNS} FROM bill_split_participants
      WHERE split_id = $1 ORDER BY created_at ASC, ext_ref ASC`,
    [splitId]
  )).rows;

  const claims = split.mode === 'ITEMS'
    ? (await db.query(
      `SELECT bill_item_id, participant_id FROM bill_split_items WHERE split_id = $1`,
      [splitId]
    )).rows
    : [];

  const rate = bill?.fx_rate_ves_per_unit
    ?? (await db.query('SELECT fx_rate_ves_per_unit FROM bills WHERE id = $1 AND restaurant_id = $2',
      [split.bill_id, restaurantId])).rows[0]?.fx_rate_ves_per_unit
    ?? null;

  return { split, participants, claims, fxRate: rate };
}

/**
 * The split that currently governs a bill, or null.
 *
 * ACTIVE if there is one, otherwise the most recent STALE one. Returning the
 * stale split rather than nothing is what lets a client tell "the bill changed,
 * agree a new split" from "this table never agreed one" -- two states that would
 * otherwise both be an empty result, and only one of which needs explaining to
 * a diner. VOID splits are excluded: those were discarded deliberately and
 * nothing was ever paid into them.
 */
async function getActiveSplit({ restaurantId, billId, bill = null }) {
  const row = (await db.query(
    `SELECT id FROM bill_splits
      WHERE restaurant_id = $1 AND bill_id = $2 AND status <> 'VOID'
      ORDER BY (status = 'ACTIVE') DESC, created_at DESC
      LIMIT 1`,
    [restaurantId, billId]
  )).rows[0];
  if (!row) return null;
  return getSplit({ restaurantId, splitId: row.id, bill });
}

/**
 * Descarta un reparto que todavía no ha recibido dinero.
 *
 * **Corre dentro de la transacción del llamante**, y recibe su cliente por eso:
 * anular el viejo y escribir el nuevo tienen que confirmarse juntos, o queda
 * una cuenta sin ningún reparto y un comensal mirando una lista vacía.
 *
 * La regla que impone es la que separa un borrador de un registro: mientras
 * nadie haya pagado, un reparto es una propuesta y se reemplaza; en cuanto hay
 * dinero contra una parte, es un registro y deshacerlo dejaría huérfanos los
 * pagos que la citan.
 *
 * Y «dinero» no es sólo lo cobrado. Un pago móvil declarado o un cargo C2P en
 * duda nombran una parte y aún no la han acreditado: anular por debajo de uno
 * deja ese dinero sin sitio donde caer cuando por fin se confirme.
 */
async function discardUnpaidSplit(client, { restaurantId, billId, splitId }) {
  // Bloqueado, no sólo sumado. `advanceShare` bloquea la fila de la parte y lee
  // el estado del reparto por un join sin bloquearlo, así que un SUM sin
  // bloqueo podría leer cero mientras un pago se confirma al lado -- y saldrían
  // los dos, dejando un reparto VOID con dinero acreditado en una de sus partes.
  const shares = (await client.query(
    `SELECT id, amount_paid_ves FROM bill_split_participants
      WHERE split_id = $1 AND restaurant_id = $2
      FOR UPDATE`,
    [splitId, restaurantId]
  )).rows;

  const paid = shares.reduce((total, share) => total + BigInt(share.amount_paid_ves), 0n);
  if (paid > 0n) {
    throw new ApiError('SPLIT_HAS_PAYMENTS', 'A split with payments against it cannot be voided');
  }

  if (shares.length) {
    const inFlight = (await client.query(
      `SELECT count(*)::int AS count FROM payments
        WHERE restaurant_id = $1
          AND split_participant_id = ANY($2::uuid[])
          AND status IN ('PENDING', 'IN_DOUBT', 'AMBIGUOUS')`,
      [restaurantId, shares.map(share => share.id)]
    )).rows[0];

    if (inFlight.count > 0) {
      throw new ApiError(
        'SPLIT_HAS_PAYMENTS',
        'A payment against one of these shares is still being resolved; settle or reject it before voiding',
        { inFlightPayments: inFlight.count }
      );
    }
  }

  await client.query(
    `UPDATE bill_splits SET status = 'VOID'
      WHERE id = $1 AND restaurant_id = $2 AND bill_id = $3`,
    [splitId, restaurantId, billId]
  );
}

/**
 * Anula un reparto, a petición del personal.
 *
 * La regla de cuándo se puede -- mientras nadie haya pagado -- la impone
 * `discardUnpaidSplit`. Lo propio de aquí es el resto: comprobar que el reparto
 * existe, que está en esta cuenta y que sigue activo, y dejar el rastro.
 */
async function voidSplit({ restaurantId, billId, splitId, actor }) {
  const result = await db.withTransaction(async client => {
    // Scoped to the bill as well as the tenant, and `billId` is required rather
    // than optional so a caller cannot quietly opt out of the check.
    //
    // `/bills/:id/splits/:splitId/void` states a containment relationship, and
    // until this clause existed nothing enforced it: any of the restaurant's
    // own bill ids in the path voided any of its splits. Crossed ids in a
    // client voided the wrong table's plan, the response came back naming a
    // bill the caller had not asked about, and -- because voiding releases the
    // one-ACTIVE-split-per-bill index -- the group still using that plan could
    // have a second one created underneath them.
    const split = (await client.query(
      `SELECT id, status FROM bill_splits
        WHERE id = $1 AND restaurant_id = $2 AND bill_id = $3
        FOR UPDATE`,
      [splitId, restaurantId, billId]
    )).rows[0];
    // Not "wrong bill": a split that is not on this bill does not exist at this
    // address, which is the same answer a split from another tenant gets.
    if (!split) throw new ApiError('SPLIT_NOT_FOUND', 'Split not found');
    if (split.status !== 'ACTIVE') {
      throw new ApiError('SPLIT_NOT_ACTIVE', 'That split has already been voided', { status: split.status });
    }

    // El porqué de los bloqueos y de qué cuenta como «pagado» está en
    // `discardUnpaidSplit`, que es ahora el único sitio donde vive esa regla.
    await discardUnpaidSplit(client, { restaurantId, billId, splitId });
    return split.id;
  });

  await logAudit({
    restaurantId,
    actorId: actor?.id ?? null,
    action: 'BILL_SPLIT_VOIDED',
    resourceType: 'bill_split',
    resourceId: result
  });

  return getSplit({ restaurantId, splitId: result });
}

/**
 * Advances a share by a settled amount, on the caller's transaction.
 *
 * The single point every rail's settlement passes through to credit a share --
 * called from src/services/payments.js when a payment carrying a
 * split_participant_id reaches a settled state, in the same transaction that
 * moved the money. The row is locked first so two diners paying one share
 * serialise, and the not-overpaid CHECK is what turns "pay more than your
 * share" into a rejection rather than a silently oversized amount_paid_ves.
 *
 * Returns nothing; throws SPLIT_SHARE_OVERPAID on the ceiling, SPLIT_SHARE_NOT_FOUND
 * if the id does not resolve within the tenant.
 */
async function advanceShare(client, { splitParticipantId, restaurantId, amountVes, billId }) {
  // Locked, and joined to its split so the share cannot be credited unless it
  // belongs to the bill this payment settled and its split is still live.
  // Without the bill check, paying one bill could mark a share of another's
  // split as paid; without the status check, a voided plan could still be
  // settled against.
  const locked = (await client.query(
    `SELECT p.id, p.amount_ves, p.amount_paid_ves, s.bill_id, s.status
       FROM bill_split_participants p
       JOIN bill_splits s ON s.id = p.split_id AND s.restaurant_id = p.restaurant_id
      WHERE p.id = $1 AND p.restaurant_id = $2
      FOR UPDATE OF p`,
    [splitParticipantId, restaurantId]
  )).rows[0];
  if (!locked || (billId != null && locked.bill_id !== billId)) {
    throw new ApiError('SPLIT_SHARE_NOT_FOUND', 'That split participant does not belong to this bill');
  }
  if (locked.status === 'STALE') {
    // The bill changed after this plan was agreed, so the plan no longer covers
    // it. Told apart from a deliberate void because the remedy differs: agree a
    // new split on the new total.
    const { rows } = await client.query(
      'SELECT total_due_ves FROM bills WHERE id = $1 AND restaurant_id = $2',
      [locked.bill_id, restaurantId]
    );
    throw new ApiError(
      'SPLIT_STALE',
      'The bill changed after this split was agreed; agree a new one before paying',
      { billTotalVes: rows[0]?.total_due_ves ?? null }
    );
  }
  if (locked.status !== 'ACTIVE') {
    throw new ApiError('SPLIT_NOT_ACTIVE', 'That split has been voided', { status: locked.status });
  }

  try {
    await client.query(
      `UPDATE bill_split_participants
          SET amount_paid_ves = amount_paid_ves + $1
        WHERE id = $2 AND restaurant_id = $3`,
      [String(amountVes), splitParticipantId, restaurantId]
    );
  } catch (err) {
    if (err.code === '23514' && String(err.constraint || '').includes('not_overpaid')) {
      const remaining = BigInt(locked.amount_ves) - BigInt(locked.amount_paid_ves);
      throw new ApiError(
        'SPLIT_SHARE_OVERPAID',
        'This payment exceeds what is left on that share',
        { shareRemainingVes: remaining.toString() }
      );
    }
    throw err;
  }
}

/**
 * Le pone nombre a una parte del reparto.
 *
 * El nombre existía, pero sólo lo podía dar quien CREABA el reparto: a quien
 * llegaba después y tocaba una parte no se le preguntaba nunca. Resultado, la
 * lista decía «Comensal 2, Comensal 3, Comensal 4» casi siempre, y lo que
 * debía servir para que la mesa vea quién ha pagado no servía para nada.
 *
 * Quién puede: cualquiera con sesión de invitado en esa mesa, que es el mismo
 * nivel de confianza con el que ya se crea y se reemplaza un reparto. No hay
 * identidad de comensal que comprobar -- la sesión es de la mesa, no de la
 * persona -- y fingir que la hay sería inventarse una garantía.
 *
 * Hasta cuándo: mientras esa parte no haya recibido dinero. Es la misma regla
 * que gobierna el reparto entero y por el mismo motivo -- sin pagos es una
 * propuesta y se corrige; con un pago detrás es el registro de quién pagó, y
 * dejar que otro lo reescriba después cambia a quién se le atribuye un dinero
 * que ya entró.
 *
 * La cadena vacía borra el nombre, para poder deshacer una errata sin tener
 * que rehacer el reparto.
 */
async function nameShare({ restaurantId, billId, ref, name }) {
  // La transacción devuelve el id y la lectura va después de confirmar, como en
  // `createSplit`: `getSplit` usa el pool, así que llamarlo desde dentro lee por
  // otra conexión y devuelve el nombre de antes. Lo destapó la prueba.
  const splitId = await db.withTransaction(async client => {
    const split = (await client.query(
      `SELECT id FROM bill_splits
        WHERE restaurant_id = $1 AND bill_id = $2 AND status = 'ACTIVE'
        FOR UPDATE`,
      [restaurantId, billId]
    )).rows[0];
    if (!split) throw new ApiError('SPLIT_NOT_FOUND', 'This bill has no active split');

    const share = (await client.query(
      `SELECT id, amount_paid_ves FROM bill_split_participants
        WHERE split_id = $1 AND restaurant_id = $2 AND ext_ref = $3
        FOR UPDATE`,
      [split.id, restaurantId, ref]
    )).rows[0];
    // «No está» y no «no es tuya»: una referencia que no existe en este reparto
    // no tiene dirección, igual que una de otra cuenta.
    if (!share) throw new ApiError('SPLIT_SHARE_NOT_FOUND', 'That share is not part of this split');

    if (BigInt(share.amount_paid_ves) > 0n) {
      throw new ApiError('SPLIT_HAS_PAYMENTS',
        'That share has already been paid into; its name cannot change');
    }

    const trimmed = String(name ?? '').trim();
    await client.query(
      'UPDATE bill_split_participants SET name = $3 WHERE id = $1 AND restaurant_id = $2',
      [share.id, restaurantId, trimmed === '' ? null : trimmed]
    );

    return split.id;
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });

  return getSplit({ restaurantId, splitId });
}

module.exports = {
  createSplit, getSplit, getActiveSplit, voidSplit, advanceShare, nameShare
};
