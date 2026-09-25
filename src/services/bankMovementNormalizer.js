/**
 * Un movimiento del banco, tal como llega de cualquier fuente, a una forma única.
 *
 * Cada banco escribe los importes, las fechas y las referencias a su manera, y
 * cada fuente (un estado de cuenta, un webhook, una API) añade la suya. Esto es
 * el único sitio donde se interpretan, para que el matcher reciba siempre lo
 * mismo: `amountMinor` en céntimos como cadena de dígitos, la referencia sólo
 * con dígitos, y lo demás limpio o null.
 *
 * Una fila que no se entiende se **rechaza con su motivo**, nunca se adivina:
 * un importe mal leído -- 1.234 tomado como 1,234 -- es un movimiento de mil
 * veces menos, y casaría con el aviso equivocado.
 */

/** Caracas no cambia de hora: UTC-4 todo el año. */
const CARACAS_OFFSET = '-04:00';

/**
 * «1.234,56», «1234,56», «1,234.56», «1234.56», «Bs 1.234,56» → céntimos.
 *
 * Con los dos separadores, el último es el decimal. Con uno solo, es decimal
 * si le siguen uno o dos dígitos al final; con exactamente tres, es de miles
 * («1.234» es mil doscientos treinta y cuatro en Venezuela). Más de dos
 * decimales se rechaza: un banco no mueve fracciones de céntimo.
 */
function parseAmount(raw) {
  if (raw == null) return { ok: false, reason: 'amount' };
  let s = String(raw).trim().replace(/\s/g, '').replace(/^(bs\.?s?|ves|bs)/i, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/^\+/, '');
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return { ok: false, reason: 'amount' };

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let whole;
  let frac = '';

  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    whole = s.slice(0, decimalAt).replace(/[.,]/g, '');
    frac = s.slice(decimalAt + 1);
    if (/[.,]/.test(frac)) return { ok: false, reason: 'amount' };
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const tailPart = parts[parts.length - 1];
    if (parts.length === 2 && tailPart.length >= 1 && tailPart.length <= 2) {
      whole = parts[0];
      frac = tailPart;
    } else if (parts.slice(1).every(p => p.length === 3)) {
      whole = parts.join('');
    } else {
      return { ok: false, reason: 'amount' };
    }
  } else {
    whole = s;
  }

  if (frac.length > 2) return { ok: false, reason: 'amount_precision' };
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return { ok: false, reason: 'amount' };
  const minor = BigInt((whole || '0') + frac.padEnd(2, '0'));
  if (negative) return { ok: false, reason: 'debit' };
  if (minor <= 0n) return { ok: false, reason: 'amount' };
  return { ok: true, value: minor.toString() };
}

/**
 * Fecha del banco → ISO. Admite ISO, «DD/MM/AAAA», «DD-MM-AAAA» y «DD/MM/AAAA
 * HH:mm[:ss]». Sin zona, se entiende hora de Caracas. Una fecha que no se
 * entiende es null, no un rechazo: la fecha ayuda a leer, no decide nada.
 */
function parseDate(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  let iso = null;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (dmy) {
    const [, d, m, y, hh = '12', mm = '00', ss = '00'] = dmy;
    iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:${ss}${CARACAS_OFFSET}`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    iso = `${s}T12:00:00${CARACAS_OFFSET}`;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    iso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}${CARACAS_OFFSET}`;
  }
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const digitsOnly = v => String(v ?? '').replace(/\D/g, '');

/** «V-12.345.678» → «V12345678». Sin letra conocida, sólo los dígitos. */
function normaliseId(raw) {
  if (raw == null) return null;
  const s = String(raw).toUpperCase().replace(/[^VEJGP0-9]/g, '');
  const m = /^([VEJGP]?)(\d{5,10})$/.exec(s);
  return m ? `${m[1]}${m[2]}` : null;
}

/**
 * Una fila cualquiera → `{ ok, movement }` o `{ ok: false, reason }`.
 *
 * Acepta `amountMinor` (céntimos, dígitos) o `amount` (texto con decimales);
 * si vienen los dos manda `amountMinor`, que no necesita interpretación.
 */
function normalise(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'shape' };

  const reference = digitsOnly(input.reference);
  if (reference.length < 4 || reference.length > 40) return { ok: false, reason: 'reference' };

  let amountMinor;
  if (input.amountMinor != null && String(input.amountMinor).trim() !== '') {
    const a = String(input.amountMinor).trim();
    if (!/^\d{1,15}$/.test(a) || BigInt(a) <= 0n) return { ok: false, reason: 'amount' };
    amountMinor = BigInt(a).toString();
  } else {
    const parsed = parseAmount(input.amount);
    if (!parsed.ok) return parsed;
    amountMinor = parsed.value;
  }

  const phone = digitsOnly(input.phoneOrigin);
  const bank = digitsOnly(input.bankCode);
  const description = input.description == null ? null : String(input.description).trim().slice(0, 200) || null;

  return {
    ok: true,
    movement: {
      reference,
      amountMinor,
      occurredAt: parseDate(input.occurredAt ?? input.date),
      phoneOrigin: phone.length >= 7 && phone.length <= 15 ? phone : null,
      idOrigin: normaliseId(input.idOrigin),
      bankCode: bank.length === 4 ? bank : null,
      description
    }
  };
}

module.exports = { normalise, parseAmount, parseDate, normaliseId };
