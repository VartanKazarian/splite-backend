const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { canIssue, activeProvider } = require('../src/services/fiscalInvoicing');

/**
 * Si se puede pedir factura aquí, dicho **antes** de que nadie lo intente.
 *
 * Esto existe por un fallo concreto, no por simetría. Al comensal se le decía
 * «podrás pedir la factura cuando el restaurante confirme tu pago» sin
 * comprobar nada, y sólo al pulsar -- ya confirmado el cobro -- aparecía el
 * «aquí no se piden las facturas». La promesa no era sólo falsa: quien
 * necesitaba factura no se la pedía al personal **porque la app le había dicho
 * que esperara**, y para cuando se enteraba podía estar ya en la puerta.
 *
 * Las tres condiciones que rechazan se sabían desde el principio. Aquí se
 * comprueba que juntarlas no pierde ninguna.
 */

const original = { ...config.fiscal };
afterEach(() => { Object.assign(config.fiscal, original); });

/** El despliegue de producción de hoy: emisión propia, sin simulado. */
const own = () => Object.assign(config.fiscal, { provider: 'own', mockEnabled: false });
const imprenta = () => Object.assign(config.fiscal, { provider: 'digitalPrinter', mockEnabled: false });
const nadie = () => Object.assign(config.fiscal, { provider: '', mockEnabled: false });

test('el plan manda: sólo ENTERPRISE incluye facturación', () => {
  own();
  for (const tier of ['TRIAL', 'STARTER', 'PRO']) {
    assert.equal(canIssue({ planTier: tier, hasSeries: true, hasRif: true }), false, `${tier} no lo incluye`);
  }
  assert.equal(canIssue({ planTier: 'ENTERPRISE', hasSeries: true, hasRif: true }), true);
});

test('sin emisor en el despliegue no se promete nada, ni al plan que lo incluye', () => {
  nadie();
  assert.equal(canIssue({ planTier: 'ENTERPRISE', hasSeries: true, hasRif: true }), false);
});

test('emitiendo nosotros, sin serie autorizada no se puede numerar', () => {
  // Es la condición que un restaurante recién subido a ENTERPRISE cumple mal:
  // tiene el plan y el despliegue, y todavía no ha transcrito su autorización.
  own();
  assert.equal(canIssue({ planTier: 'ENTERPRISE', hasSeries: false, hasRif: true }), false);
  assert.equal(canIssue({ planTier: 'ENTERPRISE', hasSeries: true, hasRif: true }), true);
});

test('con imprenta la serie no aplica: los números llegan de fuera', () => {
  imprenta();
  assert.equal(canIssue({ planTier: 'ENTERPRISE', hasSeries: false, hasRif: true }), true);
});

test('el simulado cuenta como emisor, y sólo existe fuera de producción', () => {
  // `assertProductionConfig` rechaza la bandera en producción, así que esto no
  // puede prometerle nada a un comensal de verdad.
  Object.assign(config.fiscal, { provider: '', mockEnabled: true });
  assert.equal(activeProvider(), 'mock');
  assert.equal(canIssue({ planTier: 'ENTERPRISE', hasSeries: false, hasRif: true }), true);
});

test('un plan que no se reconoce cierra la puerta, no la abre', () => {
  /*
   * `entitlements` valida el nombre de la **capacidad**, no el del plan, así
   * que un tier que no existe simplemente no está en la lista y esto contesta
   * que no. Esperaba que reventara y estaba equivocado -- y la forma que tiene
   * es la buena para este sitio: la columna lleva un CHECK, así que un valor
   * raro es casi imposible, y si pasara, tumbar la pantalla de cuenta de cada
   * comensal con un 500 sería mucho peor que no ofrecer factura.
   *
   * Lo que no puede pasar es lo contrario -- que un plan desconocido se lea
   * como «sí puede» --, y eso es lo que fija esta prueba.
   */
  own();
  assert.equal(canIssue({ planTier: 'PREMIUM', hasSeries: true, hasRif: true }), false);
});

test('sin el RIF del emisor no se emite, lo imprima quien lo imprima', () => {
  /*
   * Es contenido obligatorio de una factura fiscal venezolana, no una línea
   * decorativa del encabezado -- así que no depende de quién ponga los números.
   *
   * Antes no lo comprobaba nadie: el correo imprimía el RIF con un
   * `if (restaurant.rif)` y el recibo lo pasaba como `?? null`, de modo que un
   * restaurante sin RIF emitía documentos incompletos **en silencio**. Ésa es
   * la peor forma de fallar aquí: el papel sale, parece una factura, y no
   * sirve para desgravar.
   */
  own();
  assert.equal(canIssue({ planTier: 'ENTERPRISE', hasSeries: true, hasRif: false }), false);

  imprenta();
  assert.equal(canIssue({ planTier: 'ENTERPRISE', hasSeries: true, hasRif: false }), false,
    'tampoco con imprenta: el RIF es del emisor, no de quien imprime');
});
