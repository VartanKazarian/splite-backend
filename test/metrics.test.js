const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const pino = require('pino');

const metrics = require('../src/services/metrics');
const { REDACT_PATHS } = require('../src/connectors/logger');

/**
 * The numbers an operator watches.
 *
 * The counter half is collected at the logger rather than at call sites, so
 * what is tested here is that arrangement: a failure logged anywhere becomes a
 * metric without anybody instrumenting it.
 */

afterEach(() => metrics.reset());

/** A logger wired exactly like the real one, writing to memory. */
function countingLogger() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(JSON.parse(chunk.toString())); cb(); }
  });
  const logger = pino({
    level: 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    hooks: {
      logMethod(args, method, level) {
        const arg = args[0];
        if (level >= 40 && arg && typeof arg === 'object' && arg.event) {
          metrics.increment('splite_events_total', {
            event: String(arg.event), level: level >= 50 ? 'error' : 'warn'
          });
        }
        return method.apply(this, args);
      }
    }
  }, stream);
  return { logger, lines };
}

test('a failure logged anywhere becomes a metric with nobody instrumenting it', async () => {
  // The whole point of collecting at the logger. Instrumenting by hand would
  // have meant 27 call sites and a 28th somebody forgets -- which is how an
  // audit write came to be swallowed with nothing watching.
  const { logger } = countingLogger();

  logger.error({ event: 'AUDIT_WRITE_FAILED' }, 'audit');
  logger.error({ event: 'AUDIT_WRITE_FAILED' }, 'audit again');
  logger.warn({ event: 'RATE_LIMIT_BACKEND_UNAVAILABLE' }, 'redis');

  const text = await metrics.render();
  assert.match(text, /splite_events_total\{event="AUDIT_WRITE_FAILED",level="error"\} 2/);
  assert.match(text, /splite_events_total\{event="RATE_LIMIT_BACKEND_UNAVAILABLE",level="warn"\} 1/);
});

test('routine lines are not failures and are not counted', async () => {
  const { logger } = countingLogger();
  logger.info({ event: 'REQUEST_COMPLETED' }, 'ok');
  logger.debug({ event: 'SOMETHING' }, 'noise');

  assert.equal((await metrics.render()).includes('REQUEST_COMPLETED'), false);
});

test('a line with no event name is logged and not counted', async () => {
  // Not every warning is a named failure, and inventing a metric called
  // "undefined" helps nobody.
  const { logger, lines } = countingLogger();
  logger.warn({ billId: 'b1' }, 'something odd');

  assert.equal(lines.length, 1, 'it is still logged');
  assert.equal((await metrics.render()).trim(), '');
});

test('a gauge that fails is skipped, and the gap is itself counted', async () => {
  // A monitoring endpoint that goes dark because one query failed removes the
  // visibility it exists for, at the moment it is most wanted.
  metrics.registerGauge('splite_good', 'fine', () => 7);
  metrics.registerGauge('splite_bad', 'broken', () => { throw new Error('database is down'); });

  const text = await metrics.render();
  assert.match(text, /splite_good 7/);
  assert.equal(text.includes('splite_bad'), false);
  assert.match(text, /event="METRICS_GAUGE_FAILED"/);
});

test('a gauge returning null is omitted rather than reported as zero', async () => {
  // The oldest-claim age with an empty queue: there is no oldest claim, and
  // zero would read as one that just arrived.
  metrics.registerGauge('splite_nothing', 'absent', () => null);
  assert.equal((await metrics.render()).includes('splite_nothing'), false);
});

test('a gauge may report several labelled series', async () => {
  metrics.registerGauge('splite_unresolved_c2p', 'waiting', () => ([
    { labels: { status: 'IN_DOUBT' }, value: 2 },
    { labels: { status: 'AMBIGUOUS' }, value: 0 }
  ]));

  const text = await metrics.render();
  assert.match(text, /splite_unresolved_c2p\{status="IN_DOUBT"\} 2/);
  // Emitted at zero rather than omitted, so a dashboard shows a zero instead of
  // a gap where the series used to be.
  assert.match(text, /splite_unresolved_c2p\{status="AMBIGUOUS"\} 0/);
});

test('label values cannot break the exposition format', async () => {
  // Event names are uppercase and safe, but a metric endpoint that can be
  // corrupted by a string is one nobody can trust.
  metrics.increment('splite_events_total', { event: 'A"B\\C\nD', level: 'warn' });
  const text = await metrics.render();

  assert.match(text, /event="A\\"B\\\\C\\nD"/);
  assert.equal(text.split('\n').filter(l => l.startsWith('splite_events_total{')).length, 1);
});

test('every metric carries a type line, and counters declare their help', async () => {
  metrics.increment('splite_events_total', { event: 'X', level: 'warn' });
  metrics.registerGauge('splite_pending_claims', 'waiting for staff', () => 3);

  const text = await metrics.render();
  assert.match(text, /# TYPE splite_events_total counter/);
  assert.match(text, /# HELP splite_events_total .+/);
  assert.match(text, /# TYPE splite_pending_claims gauge/);
  assert.match(text, /# HELP splite_pending_claims waiting for staff/);
  assert.ok(text.endsWith('\n'), 'the format is line-oriented and ends with one');
});
