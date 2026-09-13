#!/usr/bin/env node

const db = require('../src/connectors/base');
const mailer = require('../src/services/mailer');
const fiscalMail = require('../src/services/fiscalMail');

/**
 * Manda las facturas que quedaron sin entregar.
 *
 *   npm run fiscal:mail                 hasta 50
 *   npm run fiscal:mail -- --limit 200  más de golpe
 *
 * Existe porque el envío del camino caliente **no se espera**: la respuesta al
 * comensal no debe colgar de un SMTP que puede tardar diez segundos. El precio
 * es que un proceso reiniciado a mitad deja la entrega en PENDING, y sin esto
 * esa factura no se mandaría nunca -- que es peor que la latencia que se
 * ahorró.
 *
 * También recoge las que fallaron, hasta el tope de intentos. Un proveedor
 * caído durante diez minutos no debería costar diez facturas perdidas.
 *
 * Un comando y no un temporizador dentro de la API, por lo mismo que la purga:
 * el proceso web se replica, y N réplicas mandando el mismo correo son N
 * correos. Va en el pase de mantenimiento.
 */

async function run() {
  const index = process.argv.indexOf('--limit');
  const limit = index >= 0 ? Number(process.argv[index + 1]) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('--limit must be an integer between 1 and 500');
  }

  const counts = await fiscalMail.sweepPending({ limit });

  if (counts.attempted === 0) {
    console.log('Nothing pending: every issued invoice with an address has been delivered.');
    return;
  }
  console.log(`Attempted ${counts.attempted}: ${counts.sent} sent, ${counts.failed} still undelivered.`);

  // Lo que queda agotado necesita a una persona: una dirección mal escrita no
  // se arregla reintentando.
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM fiscal_invoice_deliveries
      WHERE status <> 'SENT' AND attempts >= $1`, [fiscalMail.MAX_ATTEMPTS]
  );
  if (rows[0].n > 0) {
    /*
     * Se avisa, pero **no** se sale con 1.
     *
     * El pase de mantenimiento reporta el peor código de sus pasos, y ahí un 1
     * ya significa una cosa concreta: descuadre entre el libro de pagos y la
     * caché, o sea dinero que no suma. Una factura que no llegó a un correo
     * mal escrito es un problema real y de otra clase; mezclarlos haría que un
     * operador leyera «descuadre» donde no lo hay, y a la tercera vez dejaría
     * de mirar el que sí importa.
     */
    console.log(
      `\nWARNING: ${rows[0].n} delivery(ies) gave up after ${fiscalMail.MAX_ATTEMPTS} ` +
      'attempts and will not be retried. Check the address on each and resend.'
    );
  }
}

run()
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    // El transporte SMTP mantiene un socket abierto y agrupado: sin cerrarlo el
    // proceso no termina.
    await mailer.closeTransport();
    await db.close();
  });
