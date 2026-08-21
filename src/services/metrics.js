const db = require('../connectors/base');

/**
 * Numbers an operator can watch, in Prometheus text format.
 *
 * Until now the only instrumentation was the log stream, which answers "what
 * happened" and not "how often, and is it getting worse". Nobody could see a
 * C2P failure rate climbing or a claims queue going forty deep without grepping
 * for it or running the reconciler by hand -- and both of those are things
 * somebody does after a restaurant complains, not before.
 *
 * Hand-rolled rather than `prom-client`, for the reason `src/services/totp.js`
 * is hand-rolled: the exposition format is a few lines of text, the production
 * dependency surface is small and every package in it is in the path of
 * somebody's money. This is about a hundred lines and no new advisory to track.
 *
 * ---------------------------------------------------------------------------
 * Counters are collected at the *logger*, not at 27 call sites.
 *
 * Every failure this service knows how to have already goes through one funnel:
 * a `logger.warn` or `logger.error` carrying an `event` field. Incrementing a
 * counter there means a new failure mode is counted the moment somebody logs
 * it, without remembering to instrument it -- and the metric vocabulary is the
 * event vocabulary the codebase already uses.
 *
 * Instrumenting by hand would have meant 27 edits and a 28th that somebody
 * forgets, which is exactly how `AUDIT_WRITE_FAILED` came to be swallowed with
 * nothing watching in the first place.
 * ---------------------------------------------------------------------------
 */

const counters = new Map();
const gauges = [];

/** Prometheus label values: backslash, quote and newline are the three. */
const escape = value => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n');

const keyFor = (name, labels) => {
  const pairs = Object.keys(labels).sort().map(k => `${k}="${escape(labels[k])}"`);
  return pairs.length ? `${name}{${pairs.join(',')}}` : name;
};

/** Adds to a counter, creating it on first sight. */
function increment(name, labels = {}, by = 1) {
  const key = keyFor(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

/**
 * A number read at scrape time rather than accumulated.
 *
 * `read` may be async and may return either a number or a list of
 * `{ labels, value }`. It runs on every scrape, so it must be a cheap indexed
 * query and nothing more -- a gauge that takes a second to answer turns
 * monitoring into load.
 */
function registerGauge(name, help, read) {
  gauges.push({ name, help, read });
}

const HELP = {
  splite_events_total: 'Warnings and errors by event name, counted where they are logged.'
};

/**
 * There is deliberately no payment counter here.
 *
 * The obvious one -- increment on each state transition -- would have to fire
 * inside the caller's transaction, which is the only place that knows a
 * transition happened. A transaction that rolls back after it would leave the
 * count claiming money moved when none did, and a number about money that can
 * be wrong is worse than no number.
 *
 * The ledger already holds the exact answer, so throughput belongs in a gauge
 * over `payments` rather than in a counter beside it. That query needs an index
 * shaped for the window it asks about, and adding one for a metric is a
 * decision to take on its own rather than smuggle in here. The queues below are
 * the ones worth watching first anyway: they are what has somebody waiting.
 */

/**
 * The exposition text.
 *
 * A gauge that throws is skipped rather than failing the scrape: a monitoring
 * endpoint that goes dark because one query failed removes the visibility it
 * exists to provide, at the moment it is most wanted. The failure is counted
 * like any other, so the gap itself is visible.
 */
async function render() {
  // Gauges are read first and rendered second, so that a gauge which fails is
  // counted before the counters are written out -- the missing series and the
  // reason it is missing arrive in the same response, rather than the
  // explanation turning up one scrape later. Prometheus does not care about the
  // order of the blocks.
  const gaugeLines = [];
  for (const gauge of gauges) {
    let read;
    try {
      read = await gauge.read();
    } catch {
      increment('splite_events_total', { event: 'METRICS_GAUGE_FAILED', level: 'error' });
      continue;
    }
    if (read === null || read === undefined) continue;

    gaugeLines.push(`# HELP ${gauge.name} ${gauge.help}`);
    gaugeLines.push(`# TYPE ${gauge.name} gauge`);
    const series = Array.isArray(read) ? read : [{ labels: {}, value: read }];
    for (const point of series) {
      gaugeLines.push(`${keyFor(gauge.name, point.labels ?? {})} ${point.value}`);
    }
  }

  const lines = [];
  const byName = new Map();
  for (const [key, value] of counters) {
    const name = key.includes('{') ? key.slice(0, key.indexOf('{')) : key;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(`${key} ${value}`);
  }
  for (const [name, series] of [...byName].sort()) {
    if (HELP[name]) lines.push(`# HELP ${name} ${HELP[name]}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(...series.sort());
  }

  return `${[...lines, ...gaugeLines].join('\n')}\n`;
}

/** For tests, which must not inherit counts from each other. */
function reset() {
  counters.clear();
  gauges.length = 0;
}

/**
 * The queues a person has to work, across every restaurant.
 *
 * Deliberately cross-tenant: this endpoint answers to whoever runs the service,
 * not to a restaurant, and "somebody's diner has been waiting two hours" is the
 * same alert whichever restaurant they are sitting in.
 */
function registerQueueGauges() {
  registerGauge(
    'splite_pending_claims',
    'Declared Pago Movil payments waiting for a member of staff to confirm them.',
    async () => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS pending
           FROM payments
          WHERE status = 'PENDING' AND payment_method = 'PAGO_MOVIL'`
      );
      return rows[0].pending;
    }
  );

  registerGauge(
    'splite_oldest_pending_claim_age_seconds',
    'Age of the oldest unworked claim. The count alone cannot tell a quiet queue from an ignored one.',
    async () => {
      const { rows } = await db.query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - min(created_at)))::int AS age
           FROM payments
          WHERE status = 'PENDING' AND payment_method = 'PAGO_MOVIL'`
      );
      // Null, not zero: there is no oldest claim, and zero would read as one
      // that just arrived.
      return rows[0].age === null ? null : rows[0].age;
    }
  );

  registerGauge(
    'splite_unresolved_c2p',
    'C2P charges in a state only a person can end. The diner has been debited and is waiting.',
    async () => {
      const { rows } = await db.query(
        `SELECT status, count(*)::int AS count
           FROM payments
          WHERE payment_method = 'C2P' AND status IN ('IN_DOUBT', 'AMBIGUOUS')
          GROUP BY status`
      );
      // Always emit both, so a series that drops to zero is visible as zero
      // rather than as an absent metric a dashboard renders as a gap.
      const counts = Object.fromEntries(rows.map(r => [r.status, r.count]));
      return ['IN_DOUBT', 'AMBIGUOUS'].map(status => ({
        labels: { status }, value: counts[status] ?? 0
      }));
    }
  );
}

module.exports = { increment, registerGauge, registerQueueGauges, render, reset };
