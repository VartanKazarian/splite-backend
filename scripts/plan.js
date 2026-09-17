#!/usr/bin/env node

const db = require('../src/connectors/base');
const config = require('../src/config');
const plans = require('../src/services/plans');
const entitlements = require('../src/services/entitlements');
const { normaliseRif, formatRif } = require('../src/utils/rif');

/**
 * El plan de un restaurante.
 *
 *   npm run plan -- show <id|RIF|correo>
 *   npm run plan -- list [TRIAL|STARTER|PRO|ENTERPRISE]
 *   npm run plan -- set <id|RIF|correo> <PLAN> [--trial-days N] [--force] [nota...]
 *
 * Una línea de comandos y no una pantalla, por lo mismo que `onboarding.js`:
 * todas las sesiones de esta app están atadas a un restaurante y no existe un
 * rol de operador de plataforma. Inventarlo para vender un plan al mes sería un
 * segundo modelo de autenticación que asegurar y mantener correcto para
 * siempre. Si algún día hay consola, que llame a `src/services/plans.js`.
 *
 * Lo que sustituye es un UPDATE a mano contra la base de producción: sin
 * validar el nombre del plan, sin dejar rastro de quién lo cambió, sin tocar
 * `trial_ends_at` -- así que el panel seguía avisando de una prueba a alguien
 * que acababa de pagar -- y sin enterarse de lo que el cambio quitaba.
 */

/**
 * Un UUID se busca por id, algo con arroba por correo, y el resto por RIF.
 *
 * Las tres formas no se piden con banderas porque no hacen falta: ninguna se
 * puede confundir con otra, y quien está vendiendo un plan no debería tener que
 * decirle al programa qué clase de cosa acaba de pegar.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const locate = (key) => {
  if (UUID.test(key)) return { restaurantId: key, rif: null, email: null };
  if (key.includes('@')) return { restaurantId: null, rif: null, email: key };
  return { restaurantId: null, rif: normaliseRif(key), email: null };
};

const when = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '—');

/** Qué puede hacer hoy, y cuál de esas cosas la API refuerza de verdad. */
function printCapabilities(tier) {
  const caps = entitlements.capabilitiesFor(tier);
  for (const name of entitlements.CAPABILITIES) {
    const enforced = entitlements.ENFORCED.has(name);
    console.log(
      `  ${caps[name] ? '✓' : '·'} ${name.padEnd(24)}` +
      // La distinción importa: un `·` sin refuerzo describe lo que no entra en
      // el plan, pero la API lo deja pasar igual. Confundirlos es creer que has
      // vendido algo que no has vendido, o que has cortado algo que sigue vivo.
      (enforced ? '(la API lo exige)' : '(descriptivo, no se refuerza)')
    );
  }
}

async function show(key) {
  const r = await plans.find(locate(key));
  console.log([
    `Restaurante:  ${r.name}`,
    `ID:           ${r.id}`,
    `RIF:          ${r.rif ? formatRif(r.rif) : '—'}`,
    `Plan:         ${r.plan_tier}`,
    `Prueba hasta: ${when(r.trial_ends_at)}`,
    ''
  ].join('\n'));
  printCapabilities(r.plan_tier);
}

async function list(tier) {
  const rows = await plans.listByTier(tier || null);
  if (!rows.length) {
    console.log(tier ? `Ningún restaurante en ${tier}.` : 'Ningún restaurante.');
    return;
  }
  for (const r of rows) {
    console.log(
      `${r.plan_tier.padEnd(11)}${String(r.name).slice(0, 30).padEnd(32)}` +
      `${(r.rif ? formatRif(r.rif) : '—').padEnd(16)}${r.id}`
    );
  }
  console.log(`\n${rows.length} restaurante(s).`);
}

async function set(key, tier, { trialDays, force, note }) {
  const target = await plans.find(locate(key));

  if (target.plan_tier === tier && trialDays === null) {
    // Ni se escribe ni se audita: un apunte que dice que algo pasó de X a X es
    // ruido en el sitio donde después hay que buscar cuándo cambió de verdad.
    console.log(`${target.name} ya está en ${tier}. Sin cambios.`);
    return;
  }

  const { before, after, changes, breaking } = await plans.change({
    restaurantId: target.id, tier, trialDays, note, force
  });

  console.log(`${after.name}: ${before.plan_tier} → ${after.plan_tier}`);
  if (changes.gained.length) console.log(`  gana:   ${changes.gained.join(', ')}`);
  if (changes.lost.length) console.log(`  pierde: ${changes.lost.join(', ')}`);
  if (breaking.length) {
    console.log('\n  Forzado. Dejan de funcionar cosas que ya usaba:');
    for (const b of breaking) console.log(`    ${b.capability}: ${b.detail}`);
  }
  console.log(`\nPrueba hasta: ${when(after.trial_ends_at)}`);
  console.log(`Auditado como PLAN_CHANGED sobre ${after.id}.`);
}

function usage() {
  console.log([
    'Uso:',
    '  npm run plan -- show <id|RIF|correo>',
    `  npm run plan -- list [${entitlements.TIERS.join('|')}]`,
    `  npm run plan -- set <id|RIF|correo> <${entitlements.TIERS.join('|')}> [opciones] [nota...]`,
    '',
    'Opciones de `set`:',
    `  --trial-days N   Sólo yendo a TRIAL: cuántos días desde hoy (por defecto ${config.onboarding.trialDays}).`,
    '                   Saliendo de TRIAL la fecha se borra sola.',
    '  --force          Sigue adelante aunque la bajada le quite al restaurante',
    '                   algo que ya viene usando -- emitir facturas, hoy.',
    '',
    'La facturación fiscal es lo único que la API exige de verdad, y sólo entra',
    `en ${entitlements.INCLUDED.fiscalInvoicing.join(', ')}.`
  ].join('\n'));
  process.exitCode = 1;
}

async function run() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');

  const daysAt = argv.indexOf('--trial-days');
  let trialDays = null;
  if (daysAt !== -1) {
    trialDays = Number(argv[daysAt + 1]);
    if (!Number.isInteger(trialDays) || trialDays < 1) {
      throw new Error('--trial-days needs a whole number of days, 1 or more');
    }
  }

  // Las banderas fuera, y lo que quede son los posicionales más la nota.
  //
  // El `daysAt !== -1` no sobra: sin él, `--trial-days` ausente da `daysAt+1`
  // igual a 0 y el filtro se come el **comando**, así que todo caía en la
  // ayuda. Salió al probar el CLI de verdad, no en las pruebas del servicio.
  const flagged = new Set(daysAt === -1 ? [] : [daysAt, daysAt + 1]);
  const rest = argv.filter((arg, i) => arg !== '--force' && !flagged.has(i));
  const [command, key, tier, ...noteWords] = rest;
  const note = noteWords.join(' ') || null;

  switch (command) {
    case 'show':
      if (!key) return usage();
      return show(key);
    case 'list':
      return list(key);
    case 'set':
      if (!key || !tier) return usage();
      return set(key, tier.toUpperCase(), { trialDays, force, note });
    default:
      return usage();
  }
}

run()
  .catch(err => {
    console.error(err.message);
    if (err.details && Object.keys(err.details).length) {
      console.error(JSON.stringify(err.details, null, 2));
    }
    if (err.code === 'PLAN_DOWNGRADE_BLOCKED') {
      console.error('\nAñade --force si de verdad quieres bajarlo igualmente.');
    }
    process.exitCode = 1;
  })
  .finally(() => db.close());
