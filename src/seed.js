'use strict';

// Deterministic demo baseline (spec §4): 3 synthetic client stores, 20 synthetic
// orders, stable IDs, fixed timestamps and scripted recovery scenarios.
//
// Every row here is synthetic. `script` lists the outcome of each *future*
// attempt of an operation (the last entry repeats); `inspect_result` is what a
// simulated destination inspection reveals for an unknown outcome.

const { WORKFLOWS, targetRef } = require('./rules/workflows');

const STORES = [
  { id: 's_northstar', name: 'Northstar Goods', slack_channel: '#northstar-orders' },
  { id: 's_studio', name: 'Studio Supply', slack_channel: '#studio-supply-ops' },
  { id: 's_harbor', name: 'Harbor & Pine', slack_channel: '#harbor-pine-alerts' },
];

const USERS = [
  { id: 'u_ines', name: 'Ines Park', role: 'investigator' },
  { id: 'u_omar', name: 'Omar Haddad', role: 'operator' },
  { id: 'u_ada', name: 'Ada Brooks', role: 'admin' },
];

// Execution permission is store-scoped. Omar can execute for two of the three
// stores so the demo shows "can investigate, cannot execute".
const PERMISSIONS = [
  { user_id: 'u_omar', store_id: 's_northstar' },
  { user_id: 'u_omar', store_id: 's_studio' },
  { user_id: 'u_ada', store_id: 's_northstar' },
  { user_id: 'u_ada', store_id: 's_studio' },
  { user_id: 'u_ada', store_id: 's_harbor' },
];

const T0 = Date.UTC(2026, 9, 5, 9, 0, 0); // 2026-10-05 09:00 UTC
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

const CUSTOMERS = [
  'Customer A-17', 'Customer B-04', 'Customer C-22', 'Customer D-09', 'Customer E-31',
  'Customer F-12', 'Customer G-08', 'Customer H-26', 'Customer J-03', 'Customer K-19',
];

// One row per synthetic order. `scenario` drives which events/ops are created.
const ORDERS = [
  // Northstar Goods
  { n: 1001, store: 's_northstar', scenario: 'healthy', status: 'Fulfilled' },
  { n: 1002, store: 's_northstar', scenario: 'healthy', status: 'Open' },
  { n: 1003, store: 's_northstar', scenario: 'healthy', status: 'Fulfilled' },
  { n: 1004, store: 's_northstar', scenario: 'A_transient', status: 'Open' },
  { n: 1005, store: 's_northstar', scenario: 'C_duplicate_delivery', status: 'Open' },
  { n: 1006, store: 's_northstar', scenario: 'B_timeout_confirmed', status: 'Open' },
  { n: 1007, store: 's_northstar', scenario: 'cancel_slack_failed', status: 'Cancelled' },
  // Studio Supply
  { n: 1008, store: 's_studio', scenario: 'healthy', status: 'Fulfilled' },
  { n: 1009, store: 's_studio', scenario: 'healthy', status: 'Open' },
  { n: 1010, store: 's_studio', scenario: 'healthy', status: 'Open' },
  { n: 1011, store: 's_studio', scenario: 'healthy', status: 'Fulfilled' },
  { n: 1012, store: 's_studio', scenario: 'D_persistent', status: 'Open' },
  { n: 1013, store: 's_studio', scenario: 'failed_one_retry', status: 'Open' },
  { n: 1014, store: 's_studio', scenario: 'B_timeout_not_applied', status: 'Open' },
  // Harbor & Pine
  { n: 1015, store: 's_harbor', scenario: 'healthy', status: 'Fulfilled' },
  { n: 1016, store: 's_harbor', scenario: 'healthy', status: 'Open' },
  { n: 1017, store: 's_harbor', scenario: 'healthy', status: 'Fulfilled' },
  { n: 1018, store: 's_harbor', scenario: 'failed_one_retry', status: 'Open' },
  { n: 1019, store: 's_harbor', scenario: 'missing_event_id', status: 'Open' },
  { n: 1020, store: 's_harbor', scenario: 'cancel_airtable_failed_slack_unknown', status: 'Cancelled' },
];

const DETAILS = {
  success_upsert: 'Airtable record upserted (simulated)',
  success_cancel: 'Airtable record marked Cancelled (simulated)',
  success_notify: 'Slack message posted (simulated)',
  fail_503: 'Airtable API 503 Service Unavailable (simulated)',
  fail_422: 'Airtable 422 INVALID_VALUE_FOR_COLUMN "Total" (simulated)',
  fail_slack: 'Slack channel_not_found (simulated)',
  timeout: 'Request timed out after 30s — destination outcome unknown (simulated)',
};

function successDetail(kind) {
  return { upsert: DETAILS.success_upsert, cancel_update: DETAILS.success_cancel, notify: DETAILS.success_notify }[kind];
}

// Per-scenario definition: which events exist, initial result per op, scripts.
function scenarioEvents(scenario) {
  const ok = { initial: 'success' };
  switch (scenario) {
    case 'healthy':
      return [{ type: 'created', ops: { airtable: ok } }];
    case 'A_transient': // Fail -> Fail -> Succeed (initial + two retries)
      return [{ type: 'created', ops: { airtable: { initial: 'failed', detail: DETAILS.fail_503, script: ['failed', 'success'] } } }];
    case 'D_persistent':
      return [{ type: 'created', ops: { airtable: { initial: 'failed', detail: DETAILS.fail_422, script: ['failed'] } } }];
    case 'failed_one_retry':
      return [{ type: 'created', ops: { airtable: { initial: 'failed', detail: DETAILS.fail_503, script: ['success'] } } }];
    case 'B_timeout_confirmed': // inspection shows the record was written
      return [{ type: 'created', ops: { airtable: { initial: 'unknown', detail: DETAILS.timeout, inspect: 'success', script: ['success'] } } }];
    case 'B_timeout_not_applied': // inspection shows nothing was written; safe to retry
      return [{ type: 'created', ops: { airtable: { initial: 'unknown', detail: DETAILS.timeout, inspect: 'not_found', script: ['success'] } } }];
    case 'cancel_slack_failed':
      return [
        { type: 'created', ops: { airtable: ok } },
        { type: 'cancelled', ops: { airtable: ok, slack: { initial: 'failed', detail: DETAILS.fail_slack, script: ['success'] } } },
      ];
    case 'cancel_airtable_failed_slack_unknown':
      return [
        { type: 'created', ops: { airtable: ok } },
        {
          type: 'cancelled',
          ops: {
            airtable: { initial: 'failed', detail: DETAILS.fail_503, script: ['success'] },
            slack: { initial: 'unknown', detail: DETAILS.timeout, inspect: 'success', script: ['success'] },
          },
        },
      ];
    case 'C_duplicate_delivery':
      return [{ type: 'created', ops: { airtable: ok } }, { type: 'created', duplicateOfFirst: true }];
    case 'missing_event_id':
      return [{ type: 'created', ops: { airtable: ok } }, { type: 'created', missingEventId: true }];
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

// Build the full baseline rows for one order. Pure and deterministic.
function buildOrder(def, index) {
  const store = STORES.find((s) => s.id === def.store);
  const orderId = `o_${def.n}`;
  const shopifyOrderId = `58${String(def.n).padStart(8, '0')}`;
  const base = index * 37; // minutes after T0; spaced so recency ordering is stable
  const rows = { orders: [], events: [], operations: [], attempts: [], history: [] };

  rows.orders.push({
    id: orderId,
    store_id: store.id,
    shopify_order_id: shopifyOrderId,
    order_number: `#${def.n}`,
    shopify_status: def.status,
    total: Number((42 + ((def.n * 17) % 230) + 0.99).toFixed(2)),
    customer_alias: CUSTOMERS[index % CUSTOMERS.length],
    created_at: at(base),
    scenario: def.scenario,
  });

  const events = scenarioEvents(def.scenario);
  let firstEventRowId = null;
  events.forEach((ev, i) => {
    const minute = base + 2 + i * 9;
    const rowId = `ev_${def.n}_${ev.type}${i > 0 && events[0].type === ev.type ? `_d${i}` : ''}`;
    const extId = `shp_evt_${def.n}_${ev.type === 'created' ? 'c' : 'x'}`;
    const event = {
      id: rowId,
      store_id: store.id,
      event_id: ev.missingEventId ? null : extId,
      order_id: orderId,
      type: ev.type,
      received_at: at(minute),
      identity: 'confirmed',
      duplicate_of: null,
      closest_match: null,
      acknowledged: 0,
      source: 'simulated',
    };
    if (ev.duplicateOfFirst) {
      event.identity = 'duplicate';
      event.duplicate_of = firstEventRowId;
    }
    if (ev.missingEventId) {
      event.identity = 'uncertain';
      event.closest_match = firstEventRowId;
    }
    if (i === 0) firstEventRowId = rowId;
    rows.events.push(event);

    rows.history.push({
      event_ref: rowId, at: at(minute), actor: 'system', kind: 'received',
      message: ev.missingEventId
        ? `Shopify ${ev.type} delivery received without a stable event ID — identity uncertain, side effects held for review`
        : `Shopify order ${ev.type} event ${extId} received (simulated)`,
    });
    if (ev.duplicateOfFirst) {
      rows.history.push({
        event_ref: rowId, at: at(minute), actor: 'system', kind: 'duplicate',
        message: `Duplicate delivery of ${extId} from ${store.name} — linked to ${firstEventRowId}; no order record created and no notification repeated`,
      });
      rows.history.push({
        event_ref: firstEventRowId, at: at(minute), actor: 'system', kind: 'duplicate',
        message: `Duplicate delivery ${rowId} detected and linked to this event`,
      });
    }

    if (!ev.ops) return;
    for (const wop of WORKFLOWS[ev.type].operations) {
      const spec = ev.ops[wop.destination];
      const opId = `${rowId}_${wop.destination}`;
      rows.operations.push({
        id: opId,
        event_ref: rowId,
        destination: wop.destination,
        kind: wop.kind,
        target_ref: targetRef(wop, { shopifyOrderId, slackChannel: store.slack_channel }),
        required: 1,
        state: spec.initial,
        last_outcome: spec.detail || successDetail(wop.kind),
        updated_at: at(minute + 1),
        script: JSON.stringify(spec.script || []),
        script_pos: 0,
        inspect_result: spec.inspect || null,
      });
      rows.attempts.push({
        operation_id: opId, n: 1, started_at: at(minute), finished_at: at(minute + 1),
        result: spec.initial, detail: spec.detail || successDetail(wop.kind),
        approval_id: null, actor: 'system', source: 'simulated', kind: 'initial',
      });
      rows.history.push({
        event_ref: rowId, at: at(minute + 1), actor: 'system', kind: 'attempt',
        message: `Attempt 1 · ${wop.destination} ${wop.kind}: ${spec.initial} — ${spec.detail || successDetail(wop.kind)}`,
      });
    }
  });
  return rows;
}

function buildBaseline() {
  const all = { orders: [], events: [], operations: [], attempts: [], history: [] };
  ORDERS.forEach((def, i) => {
    const rows = buildOrder(def, i);
    for (const k of Object.keys(all)) all[k].push(...rows[k]);
  });
  return all;
}

function buildOrderBaseline(orderId) {
  const index = ORDERS.findIndex((o) => `o_${o.n}` === orderId);
  if (index < 0) return null;
  return buildOrder(ORDERS[index], index);
}

module.exports = { STORES, USERS, PERMISSIONS, ORDERS, T0, buildBaseline, buildOrderBaseline };
