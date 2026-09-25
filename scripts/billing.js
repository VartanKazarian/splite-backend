#!/usr/bin/env node

const db = require('../src/connectors/base');
const { closeTransport } = require('../src/services/mailer');
const billingRun = require('../src/services/billingRun');

/**
 * Cobros de Splite: renovar los periodos que terminaron y mandar los
 * recordatorios pendientes. Corre cada noche dentro de `npm run maintenance`.
 *
 *   npm run billing
 *
 * Nunca sale con 1 por un correo que no salió -- se reintenta en el pase
 * siguiente -- para que el 1 del mantenimiento siga significando descuadre.
 */
billingRun.run()
  .then(({ renewed, reminders }) => {
    console.log(`Cargos renovados: ${renewed.created}`);
    for (const s of renewed.skipped) console.log(`WARNING sin renovar: ${s.restaurant} (${s.code})`);
    console.log(`Recordatorios: ${reminders.sent} enviados, ${reminders.failed} fallidos, ${reminders.noRecipient} sin dueño con correo`);
    if (reminders.failed) console.log('WARNING hubo recordatorios sin enviar; se reintentan en el próximo pase.');
  })
  .catch(err => {
    console.error(`Billing failed: ${err.message}`);
    process.exitCode = 2;
  })
  .finally(async () => {
    closeTransport();
    await db.close();
  });
