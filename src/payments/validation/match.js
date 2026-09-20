/**
 * ¿Es este movimiento del banco el pago que el comensal declaró?
 *
 * Es la única pregunta de la validación automática, y de lo que se responda
 * aquí depende que una cuenta se dé por pagada. Así que la regla que gobierna
 * todo el fichero es una: **no ser más laxo que el mesero**. Hoy una persona
 * mira la app del banco y compara referencia, monto y de quién viene; si este
 * código confirma con menos que eso, lo que hemos automatizado no es su trabajo
 * sino su firma.
 *
 * De ahí que haya cinco desenlaces y no dos. «No pude confirmarlo» y «no está»
 * son cosas distintas, y ninguna de las dos es «no lo pagó»: la misma
 * distinción que ya hace el C2P de Mercantil con sus estados indeterminados,
 * por la misma razón -- si tratamos la duda como un no, el comensal vuelve a
 * pagar una cena que ya pagó.
 *
 * Sólo `MATCHED` puede confirmar sola. Todo lo demás cae al mesero, que es el
 * camino que ya existe y que funciona.
 *
 * ---------------------------------------------------------------------------
 * CONTRATO CON EL ADAPTADOR DEL BANCO
 *
 * Los movimientos llegan aquí ya normalizados: `amountMinor` en **céntimos**,
 * como cadena de dígitos, nunca en bolívares decimales. Cada banco publica lo
 * suyo -- algunos mandan `1234.56`, otros `123456` -- y convertirlo es trabajo
 * del adaptador, no de aquí. La advertencia ya escrita en el adaptador de
 * Mercantil vale igual en este sentido: confundir las dos unidades es comparar
 * contra un número cien veces mayor, y aquí el efecto sería dar por buena una
 * cuenta que nadie pagó.
 * ---------------------------------------------------------------------------
 */

/**
 * Cuántos dígitos de referencia bastan para creerse una coincidencia.
 *
 * No se puede exigir igualdad: los bancos venezolanos no coinciden ni en cuánto
 * mide una referencia de pago móvil ni en cuánta devuelven -- varios muestran
 * sólo los últimos dígitos --, así que comparar cadenas enteras daría NOT_FOUND
 * casi siempre y la validación no serviría para nada.
 *
 * Pero un sufijo corto es una coincidencia barata: con cuatro dígitos, dos
 * pagos cualesquiera del mismo día chocan cada diez mil. Ocho es el punto donde
 * la referencia deja de ser el único apoyo -- el monto exacto y el banco de
 * origen tienen que cuadrar además -- y por eso se exige junto a ellos, nunca
 * en lugar de ellos.
 */
const MIN_REFERENCE_DIGITS = 8;

/** Sólo dígitos: una referencia se transcribe a mano y llega con espacios y guiones. */
const digits = value => String(value ?? '').replace(/\D/g, '');

/** Los últimos `n` dígitos, para comparar lo que el banco sí devuelve. */
const tail = (value, n) => value.slice(-n);

/**
 * Dos referencias son la misma si una termina donde termina la otra.
 *
 * La comparación se hace sobre la más corta de las dos, que es la que manda:
 * si el banco devuelve ocho dígitos y el comensal escribió doce, lo máximo que
 * se puede afirmar es que los ocho últimos coinciden. Por debajo de
 * `MIN_REFERENCE_DIGITS` no se afirma nada, ni siquiera que no coinciden.
 */
function referenceAgrees(declared, reported) {
  const a = digits(declared);
  const b = digits(reported);
  const n = Math.min(a.length, b.length);
  if (n < MIN_REFERENCE_DIGITS) return false;
  return tail(a, n) === tail(b, n);
}

/**
 * Un teléfono coincide por sus últimos cuatro dígitos.
 *
 * El banco devuelve el origen en el formato que le da la gana -- con prefijo de
 * país, sin él, con el cero del operador o sin él -- y ninguno de esos adornos
 * distingue a un pagador de otro. Los cuatro últimos sí, y van como comprobación
 * *adicional*, nunca como la única.
 */
const phoneAgrees = (declared, reported) => {
  const a = digits(declared);
  const b = digits(reported);
  if (a.length < 4 || b.length < 4) return false;
  return tail(a, 4) === tail(b, 4);
};

/**
 * Compara un movimiento contra la reclamación y dice qué falla.
 *
 * Devuelve la lista de desacuerdos en vez de un booleano a propósito: cuando no
 * se confirma, el mesero tiene que poder leer por qué, y «el monto no cuadra»
 * y «viene de otro banco» llevan a acciones distintas. Un campo que el banco no
 * devuelve no se compara y no cuenta como desacuerdo -- no saber no es fallar.
 */
function disagreements(claim, movement) {
  const bad = [];

  // El monto no admite tolerancia. Un pago por otra cantidad es otro pago, y
  // redondear aquí sería inventar dinero que nadie transfirió.
  if (String(movement.amountMinor) !== String(claim.amountMinor)) bad.push('amount');

  if (movement.bankCode != null && String(movement.bankCode) !== String(claim.bankCode)) {
    bad.push('bank');
  }

  if (movement.phoneOrigin != null && !phoneAgrees(claim.phoneOrigin, movement.phoneOrigin)) {
    bad.push('phone');
  }

  return bad;
}

/**
 * El desenlace de buscar la reclamación entre los movimientos del banco.
 *
 * `AMBIGUOUS` es el caso que más fácil sería pasar por alto y el que más caro
 * sale: dos comensales de la misma mesa pagan lo mismo con referencias que
 * terminan igual, y confirmar «la primera que aparezca» le abona a uno el pago
 * del otro. Cuando hay dos candidatas no se elige: se para y decide una persona.
 */
function matchClaim(claim, movements = []) {
  const candidates = movements.filter(m => referenceAgrees(claim.reference, m.reference));

  if (!candidates.length) return { outcome: 'NOT_FOUND', movement: null, disagreements: [] };

  const exact = candidates.filter(m => disagreements(claim, m).length === 0);

  if (exact.length > 1) {
    return { outcome: 'AMBIGUOUS', movement: null, disagreements: [], candidates: exact.length };
  }

  if (exact.length === 1) return { outcome: 'MATCHED', movement: exact[0], disagreements: [] };

  // Hay algo con esa referencia, pero no es esto. Se informa el desacuerdo de
  // la candidata menos discrepante, que es la que el mesero querrá mirar.
  const [closest] = candidates
    .map(m => ({ movement: m, bad: disagreements(claim, m) }))
    .sort((x, y) => x.bad.length - y.bad.length);

  return { outcome: 'MISMATCH', movement: closest.movement, disagreements: closest.bad };
}

module.exports = {
  matchClaim,
  MIN_REFERENCE_DIGITS,
  _internals: { referenceAgrees, phoneAgrees, disagreements }
};
