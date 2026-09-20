const { ApiError } = require('../errors');
const { normaliseRif, hasRifShape, isValidRif, formatRif } = require('../utils/rif');

/**
 * Quién emite: el RIF del contribuyente.
 *
 * Hasta aquí el RIF sólo se podía escribir en el alta por autoservicio. `GET
 * /account` lo devolvía, pero no había forma de ponerlo ni de corregirlo, así
 * que un restaurante dado de alta por cualquier otro camino se quedaba sin él
 * -- y desde que `canIssue` lo exige, sin él no se emite ninguna factura. La
 * única salida era entrar a la base a mano, que es exactamente lo que hubo que
 * hacer con `Casa 72`.
 *
 * Va aparte del perfil por la misma razón que la serie fiscal, escrita en su
 * endpoint: no es un dato del local como el nombre, es la identidad con la que
 * declara. Mezclarlos habría significado que renombrar el restaurante y
 * cambiar de contribuyente pasan por el mismo permiso y la misma auditoría.
 *
 * Tres reglas, y la tercera es la que importa.
 */

/**
 * La forma sí se exige; el dígito verificador no.
 *
 * `utils/rif` ya dejó razonada esa asimetría y aquí se respeta: el cálculo del
 * dígito no se ha contrastado nunca contra un corpus de RIF reales, así que
 * rechazar por él arriesga dejar a un restaurante de verdad sin poder facturar
 * por un fallo nuestro. La forma, en cambio, es barata y segura de comprobar.
 *
 * Pero callarse tampoco sirve: un RIF con el dígito cambiado sale impreso en
 * cada factura y no vale para desgravar. Así que se guarda y **se avisa** --
 * `checksumOk` viaja en la respuesta para que la pantalla lo diga en voz alta
 * sin bloquear a quien sabe que su número es correcto.
 */
function parseRif(input) {
  const rif = normaliseRif(input);
  if (!hasRifShape(rif)) {
    throw new ApiError('FISCAL_RIF_MALFORMED',
      'A RIF is a type letter, eight digits and a check digit', { example: 'J-12345678-4' });
  }
  return { rif, checksumOk: isValidRif(rif) };
}

/**
 * Escribe el RIF del emisor, y deja de dejarlo cambiar en cuanto ha emitido.
 *
 * Mientras no haya salido ningún documento se puede corregir las veces que
 * haga falta: es un campo que se rellena y se enmienda. En cuanto hay una
 * factura emitida, se congela -- y no por rigidez, sino porque **cambiarlo
 * contradice lo ya emitido**. Los documentos que están en la calle llevan
 * impreso el RIF viejo; dejar que la fila diga otro haría que el libro de
 * ventas no cuadre con el papel que tiene el cliente, que es justo lo que se
 * revisa en una fiscalización.
 *
 * Es la misma regla que congela los prefijos de la serie, por el mismo motivo,
 * y con la misma salida: un error descubierto después de emitir se arregla con
 * una nota de crédito, no reescribiendo la identidad para que el error deje de
 * verse.
 *
 * El RIF es único entre inquilinos. Chocar con otro no es un fallo del
 * servidor: casi siempre significa que ese contribuyente ya tiene cuenta, y eso
 * hay que decirlo con esas palabras en vez de con un 500.
 */
async function writeRif(client, restaurantId, input) {
  const { rif, checksumOk } = parseRif(input);

  const { rows: current } = await client.query(
    'SELECT NULLIF(TRIM(rif), \'\') AS rif FROM restaurants WHERE id = $1 FOR UPDATE',
    [restaurantId]
  );
  if (!current.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

  const previous = current[0].rif;
  if (previous === rif) return { rif, checksumOk, changed: false };

  const { rows: issued } = await client.query(
    'SELECT 1 FROM fiscal_invoices WHERE restaurant_id = $1 LIMIT 1',
    [restaurantId]
  );
  if (issued.length) {
    throw new ApiError('FISCAL_RIF_LOCKED',
      'The RIF cannot change once a fiscal document has been issued under it',
      { issuedRif: previous ? formatRif(previous) : null });
  }

  try {
    await client.query(
      'UPDATE restaurants SET rif = $2, updated_at = NOW() WHERE id = $1',
      [restaurantId, rif]
    );
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'restaurants_rif_unique_idx') {
      throw new ApiError('FISCAL_RIF_TAKEN', 'Another restaurant is already registered with that RIF');
    }
    throw err;
  }

  return { rif, checksumOk, changed: true, previous };
}

module.exports = { writeRif, parseRif };
