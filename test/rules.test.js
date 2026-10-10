'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveOverallStatus } = require('../src/rules/status');
const { derivePriority } = require('../src/rules/priority');
const { classifyIncoming } = require('../src/rules/dedup');

const op = (destination, state, extra = {}) => ({ destination, kind: destination === 'slack' ? 'notify' : 'upsert', state, required: true, attempts: [], ...extra });

test('status: confirmed failure takes precedence over unknown', () => {
  assert.equal(deriveOverallStatus([op('airtable', 'failed'), op('slack', 'unknown')]), 'Failed');
});

test('status: unknown without failure is Unresolved', () => {
  assert.equal(deriveOverallStatus([op('airtable', 'success'), op('slack', 'unknown')]), 'Unresolved');
});

test('status: retrying shown when nothing failed', () => {
  assert.equal(deriveOverallStatus([op('airtable', 'success'), op('slack', 'retrying')]), 'Retrying');
  assert.equal(deriveOverallStatus([op('airtable', 'failed'), op('slack', 'retrying')]), 'Failed');
});

test('status: cancellation resolved only when both Airtable and Slack confirmed', () => {
  assert.equal(deriveOverallStatus([op('airtable', 'success'), op('slack', 'pending')]), 'Unresolved');
  assert.equal(deriveOverallStatus([op('airtable', 'success'), op('slack', 'success')]), 'Resolved');
});

test('status: optional ops do not block resolution; identity review does', () => {
  assert.equal(deriveOverallStatus([op('airtable', 'success'), op('slack', 'failed', { required: false })]), 'Resolved');
  assert.equal(deriveOverallStatus([], { identityPending: true }), 'Unresolved');
});

test('priority: unknown outcome or uncertain identity => Investigate now', () => {
  assert.equal(derivePriority({ identity: 'confirmed', operations: [op('airtable', 'failed'), op('slack', 'unknown')] }).label, 'Investigate now');
  assert.equal(derivePriority({ identity: 'uncertain', operations: [] }).label, 'Investigate now');
});

test('priority: confirmed failure => Action required; repeated failures => manual review', () => {
  const p = derivePriority({ identity: 'confirmed', operations: [op('airtable', 'failed', { attempts: [{ result: 'failed' }] })] });
  assert.equal(p.label, 'Action required');
  assert.match(p.reason, /failed/);
  const m = derivePriority({ identity: 'confirmed', operations: [op('airtable', 'failed', { attempts: [{ result: 'failed' }, { result: 'failed' }, { result: 'failed' }] })] });
  assert.match(m.reason, /Manual review/);
});

test('priority: retrying / unacknowledged duplicate => Monitor; resolved => null', () => {
  assert.equal(derivePriority({ identity: 'confirmed', operations: [op('airtable', 'retrying')] }).label, 'Monitor');
  assert.equal(derivePriority({ identity: 'duplicate', acknowledged: false, operations: [] }).label, 'Monitor');
  assert.equal(derivePriority({ identity: 'confirmed', operations: [op('airtable', 'success')] }), null);
});

const existing = [
  { id: 'e1', event_id: 'evt_1', store_id: 's_a', order_id: 'o1', type: 'created', identity: 'confirmed' },
  { id: 'e2', event_id: 'evt_2', store_id: 's_a', order_id: 'o1', type: 'cancelled', identity: 'confirmed' },
];

test('dedup: same event ID + same store is a duplicate', () => {
  assert.deepEqual(classifyIncoming({ event_id: 'evt_1', store_id: 's_a', order_id: 'o1', type: 'created' }, existing), { identity: 'duplicate', duplicate_of: 'e1' });
});

test('dedup: same event ID from a different store is a separate event', () => {
  assert.equal(classifyIncoming({ event_id: 'evt_1', store_id: 's_b', order_id: 'o9', type: 'created' }, existing).identity, 'confirmed');
});

test('dedup: different event IDs for the same order stay separate (lifecycle not collapsed)', () => {
  assert.equal(classifyIncoming({ event_id: 'evt_3', store_id: 's_a', order_id: 'o1', type: 'cancelled' }, existing).identity, 'confirmed');
});

test('dedup: missing event ID is uncertain, never auto-duplicate', () => {
  const r = classifyIncoming({ event_id: null, store_id: 's_a', order_id: 'o1', type: 'cancelled' }, existing);
  assert.deepEqual(r, { identity: 'uncertain', closest_match: 'e2' });
});
