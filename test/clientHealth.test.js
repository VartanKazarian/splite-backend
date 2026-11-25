const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { healthOf } = require('../src/services/clientHealth');

const NOW = Date.parse('2026-11-23T12:00:00Z');
const daysAgo = d => new Date(NOW - d * 86_400_000).toISOString();
const client = (o = {}) => ({ state: 'ACTIVE', createdAt: daysAgo(90), lastActivityAt: daysAgo(0), ...o });
const row = (o = {}) => ({ vol: '1000', prev_vol: '1000', has_menu: true, has_tables: true, has_bank: true, attempts: 0, failed: 0, ...o });

describe('client health', () => {
  it('a busy, set-up, paid-up client is 100', () => {
    assert.deepEqual(healthOf(client(), row(), NOW), { score: 100, level: 'GOOD', reasons: [] });
  });

  it('two idle weeks and an overdue charge put it at risk', () => {
    const h = healthOf(client({ state: 'OVERDUE', lastActivityAt: daysAgo(20) }), row(), NOW);
    assert.deepEqual(h.reasons, ['INACTIVE_14D', 'OVERDUE']);
    assert.equal(h.level, 'RISK');
  });

  it('does not ask a new client for activity, only for setup', () => {
    const h = healthOf(client({ createdAt: daysAgo(3), lastActivityAt: null }), row({ has_menu: false }), NOW);
    assert.deepEqual(h.reasons, ['NO_MENU']);
  });

  it('flags volume halving against the previous 30 days', () => {
    assert.deepEqual(healthOf(client(), row({ vol: '400', prev_vol: '1000' }), NOW).reasons, ['VOLUME_DROP_50']);
    assert.deepEqual(healthOf(client(), row({ vol: '700', prev_vol: '1000' }), NOW).reasons, ['VOLUME_DROP_25']);
  });

  it('counts failures only once there are enough attempts to mean something', () => {
    assert.deepEqual(healthOf(client(), row({ attempts: 5, failed: 3 }), NOW).reasons, []);
    assert.deepEqual(healthOf(client(), row({ attempts: 20, failed: 3 }), NOW).reasons, ['PAYMENT_FAILURES']);
  });

  it('a cancelled client has no score', () => {
    assert.equal(healthOf(client({ state: 'CANCELLED' }), row(), NOW), null);
  });

  it('never goes below zero', () => {
    const h = healthOf(client({ state: 'SUSPENDED', lastActivityAt: daysAgo(60) }), row({ has_menu: false, has_tables: false, has_bank: false }), NOW);
    assert.equal(h.score, 0);
  });
});
