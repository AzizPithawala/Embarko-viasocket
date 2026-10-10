'use strict';

// Read models. Issues, statuses, priorities and dashboard totals are all derived
// from the same rows (events, operations, attempts) so they cannot drift apart.

const { get } = require('./db');
const { deriveOverallStatus } = require('./rules/status');
const { derivePriority } = require('./rules/priority');
const { WORKFLOWS, operationLabel } = require('./rules/workflows');

function loadContext() {
  const d = get();
  const stores = new Map(d.prepare('SELECT * FROM stores').all().map((s) => [s.id, s]));
  const orders = new Map(d.prepare('SELECT * FROM orders').all().map((o) => [o.id, o]));
  return { d, stores, orders };
}

function opsFor(d, eventRef) {
  const ops = d.prepare('SELECT * FROM operations WHERE event_ref = ? ORDER BY destination').all(eventRef);
  const attemptStmt = d.prepare('SELECT * FROM attempts WHERE operation_id = ? ORDER BY n');
  return ops.map((op) => ({ ...op, required: !!op.required, label: operationLabel(op), attempts: attemptStmt.all(op.id) }));
}

function lastActivity(d, event, ops) {
  const h = d.prepare('SELECT MAX(at) AS at FROM history WHERE event_ref = ?').get(event.id);
  const times = [event.received_at, h && h.at, ...ops.map((o) => o.updated_at)].filter(Boolean);
  return times.sort().at(-1);
}

function summarize(ctx, event) {
  const { d, stores, orders } = ctx;
  const ops = opsFor(d, event.id);
  const identityPending = event.identity === 'uncertain' || (event.identity === 'duplicate' && !event.acknowledged);
  const status = deriveOverallStatus(ops, { identityPending });
  const priority = derivePriority({ identity: event.identity, acknowledged: !!event.acknowledged, operations: ops });
  const order = orders.get(event.order_id);
  const store = stores.get(event.store_id);
  const hadIssue =
    event.identity !== 'confirmed' || !!event.review_decision ||
    ops.some((op) => op.attempts.some((a) => a.result !== 'success'));
  return {
    id: event.id,
    event,
    store: { id: store.id, name: store.name, kind: store.kind },
    order,
    workflow: WORKFLOWS[event.type] ? WORKFLOWS[event.type].label : event.type,
    status,
    priority,
    open: priority !== null,
    had_issue: hadIssue,
    last_activity: lastActivity(d, event, ops),
    operations: ops,
  };
}

function compareIssues(a, b) {
  const ra = a.priority ? a.priority.rank : 9;
  const rb = b.priority ? b.priority.rank : 9;
  if (ra !== rb) return ra - rb;
  return (b.last_activity || '').localeCompare(a.last_activity || '');
}

// kind: 'live' | 'demo' narrows to that kind of client store; anything else is all.
function listIssues({ store, status, kind } = {}) {
  const ctx = loadContext();
  let events = ctx.d.prepare('SELECT * FROM events').all();
  if (store) events = events.filter((e) => e.store_id === store);
  if (kind === 'live' || kind === 'demo') events = events.filter((e) => ctx.stores.get(e.store_id)?.kind === kind);
  const all = events.map((e) => summarize(ctx, e));
  const open = all.filter((i) => i.open);

  const counts = {
    open: open.length,
    investigate_now: open.filter((i) => i.priority.rank === 1).length,
    action_required: open.filter((i) => i.priority.rank === 2).length,
    monitor: open.filter((i) => i.priority.rank === 3).length,
    by_status: {},
    resolved_issues: all.filter((i) => !i.open && i.had_issue).length,
    orders: new Set(all.map((i) => i.order.id)).size,
    events: all.length,
  };
  for (const i of open) counts.by_status[i.status] = (counts.by_status[i.status] || 0) + 1;

  const rows = (status ? open.filter((i) => i.status === status) : open).sort(compareIssues).map(compact);
  const resolved = all.filter((i) => !i.open && i.had_issue).sort(compareIssues).map(compact);
  return { counts, issues: rows, resolved };
}

function compact(i) {
  return {
    id: i.id,
    store: i.store,
    order_number: i.order.order_number,
    shopify_order_id: i.order.shopify_order_id,
    shopify_status: i.order.shopify_status,
    event_type: i.event.type,
    workflow: i.workflow,
    status: i.status,
    priority: i.priority,
    last_activity: i.last_activity,
    in_flight: i.operations.some((o) => o.state === 'retrying'),
  };
}

function getIssue(id) {
  const ctx = loadContext();
  const event = ctx.d.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!event) return null;
  const issue = summarize(ctx, event);
  issue.history = ctx.d
    .prepare('SELECT * FROM history WHERE event_ref = ? ORDER BY at, id')
    .all(id);
  issue.related_events = ctx.d
    .prepare('SELECT id, type, event_id, identity, received_at, duplicate_of FROM events WHERE order_id = ? AND id != ? ORDER BY received_at')
    .all(event.order_id, id);
  if (event.identity === 'uncertain' || event.review_decision) issue.review = reviewEvidence(ctx, event);
  if (event.duplicate_of) {
    const orig = ctx.d.prepare('SELECT * FROM events WHERE id = ?').get(event.duplicate_of);
    if (orig) issue.duplicate_of = summarizeBrief(ctx, orig);
  }
  return issue;
}

function summarizeBrief(ctx, event) {
  const s = summarize(ctx, event);
  return {
    id: s.id, event_id: event.event_id, type: event.type, received_at: event.received_at, status: s.status,
    operations: s.operations.map((o) => ({ label: o.label, state: o.state, last_outcome: o.last_outcome, updated_at: o.updated_at })),
  };
}

// Evidence for an uncertain-identity review (spec §5). Only key fields are
// exposed — never raw payloads or secrets.
function reviewEvidence(ctx, event) {
  const closest = event.closest_match ? ctx.d.prepare('SELECT * FROM events WHERE id = ?').get(event.closest_match) : null;
  const closestBrief = closest ? summarizeBrief(ctx, closest) : null;
  const sideEffectsMayHaveOccurred = !!closestBrief && closestBrief.operations.some((o) => o.state === 'success' || o.state === 'unknown');
  return {
    incoming: {
      event_id: event.event_id || '(missing)',
      type: event.type,
      store_id: event.store_id,
      shopify_order_id: ctx.orders.get(event.order_id).shopify_order_id,
      received_at: event.received_at,
    },
    closest_match: closestBrief,
    side_effects_may_have_occurred: sideEffectsMayHaveOccurred,
    reported: event.reported_json ? JSON.parse(event.reported_json) : null,
    decision: event.review_decision,
    rationale: event.review_rationale,
    reviewed_by: event.reviewed_by,
    reviewed_at: event.reviewed_at,
  };
}

function activity({ store, limit = 100 } = {}) {
  const d = get();
  const rows = d
    .prepare(`SELECT h.*, e.store_id, o.order_number FROM history h
      LEFT JOIN events e ON e.id = h.event_ref
      LEFT JOIN orders o ON o.id = e.order_id
      ORDER BY h.at DESC, h.id DESC LIMIT ?`)
    .all(limit);
  return store ? rows.filter((r) => !r.store_id || r.store_id === store) : rows;
}

module.exports = { listIssues, getIssue, activity, compareIssues };
