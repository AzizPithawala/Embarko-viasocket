'use strict';

// Incoming deliveries (viaSocket webhook or simulated redelivery) and
// uncertain-event review. Both paths share classifyIncoming so live and demo
// behave identically (spec §5).

const crypto = require('node:crypto');
const { get } = require('../db');
const { classifyIncoming } = require('../rules/dedup');
const { WORKFLOWS, targetRef } = require('../rules/workflows');
const { log, completeAttempt } = require('./execute');

const now = () => new Date().toISOString();
const RESULTS = new Set(['success', 'failed', 'unknown']);

function err(status, error) {
  return { status, error };
}

function findOrCreateOrder(d, store, p) {
  let order = d.prepare('SELECT * FROM orders WHERE store_id = ? AND shopify_order_id = ?').get(store.id, String(p.shopify_order_id));
  if (!order) {
    const id = `o_${store.id}_${p.shopify_order_id}`;
    d.prepare(`INSERT INTO orders (id, store_id, shopify_order_id, order_number, shopify_status, total, customer_alias, created_at, scenario)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
      id, store.id, String(p.shopify_order_id), p.order_number || `#${p.shopify_order_id}`,
      p.shopify_status || (p.event_type === 'cancelled' ? 'Cancelled' : 'Open'), Number(p.total || 0), p.customer_alias || 'Customer', now(),
    );
    order = d.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  } else if (p.event_type === 'cancelled' && order.shopify_status !== 'Cancelled') {
    // Shopify order state is tracked independently of sync state.
    d.prepare("UPDATE orders SET shopify_status = 'Cancelled' WHERE id = ?").run(order.id);
  }
  return order;
}

function sanitizeOps(list) {
  return (Array.isArray(list) ? list : [])
    .filter((o) => o && typeof o.destination === 'string')
    .map((o) => ({
      destination: o.destination,
      kind: o.kind || null,
      result: RESULTS.has(o.result) ? o.result : 'unknown',
      detail: String(o.detail || '').slice(0, 300),
      execution_id: o.execution_id ? String(o.execution_id).slice(0, 100) : null,
    }));
}

function recordReportedAttempt(d, op, rep, source) {
  const n = d.prepare('SELECT COUNT(*) AS c FROM attempts WHERE operation_id = ?').get(op.id).c + 1;
  const detail = (rep.detail || `Reported ${rep.result} by ${source}`) + (rep.execution_id ? ` [viaSocket execution ${rep.execution_id}]` : '');
  d.prepare(`INSERT INTO attempts (operation_id, n, started_at, finished_at, result, detail, actor, source, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(op.id, n, now(), now(), rep.result, detail, source, source, n === 1 ? 'initial' : 'reported');
  if (op.state !== 'success') {
    d.prepare('UPDATE operations SET state = ?, last_outcome = ?, updated_at = ? WHERE id = ?').run(rep.result, detail, now(), op.id);
  }
  log(op.event_ref, source, 'attempt', `Attempt ${n} · ${op.destination} ${op.kind}: ${rep.result} — ${detail}`);
}

// payload: { store_id, event_id?, shopify_order_id, event_type, order_number?, operations?: [...] }
function ingest(payload, { source }) {
  const d = get();
  const p = payload || {};
  const store = d.prepare('SELECT * FROM stores WHERE id = ?').get(p.store_id);
  if (!store) return err(400, 'Unknown store_id');
  if (!WORKFLOWS[p.event_type]) return err(400, `Unsupported event_type; required operations are defined only for: ${Object.keys(WORKFLOWS).join(', ')}`);
  if (!p.shopify_order_id) return err(400, 'shopify_order_id is required');
  const reported = sanitizeOps(p.operations);

  let out;
  d.transaction(() => {
    const order = findOrCreateOrder(d, store, p);
    const existing = d.prepare('SELECT id, event_id, store_id, order_id, type, identity FROM events WHERE store_id = ?').all(store.id);
    const cls = classifyIncoming({ event_id: p.event_id || null, store_id: store.id, order_id: order.id, type: p.event_type }, existing);
    const id = `ev_${order.shopify_order_id}_${p.event_type}_${crypto.randomBytes(3).toString('hex')}`;
    const ins = d.prepare(`INSERT INTO events (id, store_id, event_id, order_id, type, received_at, identity, duplicate_of, closest_match, acknowledged, reported_json, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);

    if (cls.identity === 'duplicate') {
      ins.run(id, store.id, p.event_id, order.id, p.event_type, now(), 'duplicate', cls.duplicate_of, null, null, source);
      log(id, source, 'received', `Delivery of event ${p.event_id} received from ${store.name}`);
      log(id, 'system', 'duplicate', `Duplicate delivery — linked to ${cls.duplicate_of}; no new order record or notification created`);
      log(cls.duplicate_of, 'system', 'duplicate', `Duplicate delivery ${id} detected and linked to this event`);
      // Reported results may confirm a not-yet-confirmed op; confirmed successes are never touched.
      const ops = d.prepare('SELECT * FROM operations WHERE event_ref = ?').all(cls.duplicate_of);
      for (const rep of reported) {
        const op = ops.find((o) => o.destination === rep.destination);
        if (op && op.state !== 'success' && op.state !== 'retrying') recordReportedAttempt(d, op, rep, source);
      }
      out = { status: 200, classification: 'duplicate', event_ref: id, duplicate_of: cls.duplicate_of };
      return;
    }

    if (cls.identity === 'uncertain') {
      ins.run(id, store.id, null, order.id, p.event_type, now(), 'uncertain', null, cls.closest_match, reported.length ? JSON.stringify(reported) : null, source);
      log(id, source, 'received', `Shopify ${p.event_type} delivery received without a stable event ID — identity uncertain, side effects held for review`);
      out = { status: 202, classification: 'uncertain', event_ref: id, closest_match: cls.closest_match };
      return;
    }

    ins.run(id, store.id, p.event_id, order.id, p.event_type, now(), 'confirmed', null, null, null, source);
    log(id, source, 'received', `Shopify order ${p.event_type} event ${p.event_id} received from ${store.name}`);
    for (const wop of WORKFLOWS[p.event_type].operations) {
      const opId = `${id}_${wop.destination}`;
      d.prepare(`INSERT INTO operations (id, event_ref, destination, kind, target_ref, required, state, last_outcome, updated_at, script)
        VALUES (?, ?, ?, ?, ?, 1, 'pending', NULL, ?, '["success"]')`).run(
        opId, id, wop.destination, wop.kind, targetRef(wop, { shopifyOrderId: order.shopify_order_id, slackChannel: store.slack_channel }), now(),
      );
      const op = d.prepare('SELECT * FROM operations WHERE id = ?').get(opId);
      const rep = reported.find((r) => r.destination === wop.destination) ||
        { result: 'unknown', detail: `No ${wop.destination} result reported by the flow — outcome unknown` };
      recordReportedAttempt(d, op, rep, source);
    }
    out = { status: 201, classification: 'new', event_ref: id };
  })();
  return out;
}

// Result callback for a live single-operation retry.
function retryResult(payload) {
  const d = get();
  const p = payload || {};
  if (!p.attempt_key) return err(400, 'attempt_key is required');
  const attempt = d.prepare('SELECT * FROM attempts WHERE attempt_key = ?').get(String(p.attempt_key));
  if (!attempt) return err(404, 'Unknown attempt_key');
  if (attempt.result) return { status: 200, duplicate: true, note: 'Result already recorded; ignored' };
  const result = RESULTS.has(p.result) ? p.result : 'unknown';
  completeAttempt(attempt.id, result, String(p.detail || `viaSocket reported ${result}`).slice(0, 300), { executionId: p.execution_id });
  return { status: 200, recorded: result };
}

const ROLES_THAT_REVIEW = new Set(['investigator', 'operator', 'admin']);

// Uncertain-event review (spec §5–§6). Classifying as new only creates pending
// operations; processing still needs explicit, fresh operator approval.
function review(user, eventRef, decision, rationale) {
  const d = get();
  if (!user || !ROLES_THAT_REVIEW.has(user.role)) return err(403, 'Not allowed');
  const ev = d.prepare('SELECT * FROM events WHERE id = ?').get(eventRef);
  if (!ev) return err(404, 'Event not found');
  if (ev.identity !== 'uncertain') return err(409, 'This event is not awaiting identity review');
  const why = String(rationale || '').trim();
  if (!['duplicate', 'new', 'uncertain'].includes(decision)) return err(400, 'decision must be duplicate, new or uncertain');
  if (decision !== 'uncertain' && why.length < 3) return err(400, 'A rationale is required');
  if (decision === 'duplicate' && !ev.closest_match) return err(409, 'No existing event to link to; classify as new or leave uncertain');

  d.transaction(() => {
    d.prepare('UPDATE events SET review_decision = ?, review_rationale = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(decision, why || null, user.id, now(), ev.id);
    if (decision === 'duplicate') {
      d.prepare("UPDATE events SET identity = 'duplicate', duplicate_of = ?, acknowledged = 1 WHERE id = ?").run(ev.closest_match, ev.id);
      log(ev.id, user.id, 'review', `${user.name} classified this delivery as a duplicate of ${ev.closest_match}. Rationale: ${why}`);
      log(ev.closest_match, user.id, 'duplicate', `Uncertain delivery ${ev.id} reviewed and linked to this event as a duplicate`);
    } else if (decision === 'new') {
      d.prepare("UPDATE events SET identity = 'confirmed' WHERE id = ?").run(ev.id);
      const store = d.prepare('SELECT * FROM stores WHERE id = ?').get(ev.store_id);
      const order = d.prepare('SELECT * FROM orders WHERE id = ?').get(ev.order_id);
      for (const wop of WORKFLOWS[ev.type].operations) {
        d.prepare(`INSERT INTO operations (id, event_ref, destination, kind, target_ref, required, state, last_outcome, updated_at, script)
          VALUES (?, ?, ?, ?, ?, 1, 'pending', 'Not yet processed — awaiting approved plan', ?, '["success"]')`).run(
          `${ev.id}_${wop.destination}`, ev.id, wop.destination, wop.kind,
          targetRef(wop, { shopifyOrderId: order.shopify_order_id, slackChannel: store.slack_channel }), now(),
        );
      }
      log(ev.id, user.id, 'review', `${user.name} classified this delivery as a new event. Rationale: ${why}. Processing requires explicit approval.`);
    } else {
      log(ev.id, user.id, 'review', `${user.name} reviewed the evidence and left identity uncertain${why ? `. Note: ${why}` : ''}`);
    }
  })();
  return { status: 200, decision };
}

function acknowledgeDuplicate(user, eventRef) {
  const d = get();
  const ev = d.prepare('SELECT * FROM events WHERE id = ?').get(eventRef);
  if (!ev) return err(404, 'Event not found');
  if (ev.identity !== 'duplicate' || ev.acknowledged) return err(409, 'Nothing to acknowledge');
  d.prepare('UPDATE events SET acknowledged = 1 WHERE id = ?').run(ev.id);
  log(ev.id, user.id, 'review', `${user.name} acknowledged the duplicate delivery; no side effects were repeated`);
  return { status: 200 };
}

// Demo helper for Scenario C: re-send an existing event as a duplicate delivery.
function simulateRedelivery(user, eventRef) {
  const d = get();
  const ev = d.prepare('SELECT * FROM events WHERE id = ?').get(eventRef);
  if (!ev) return err(404, 'Event not found');
  if (!ev.event_id) return err(409, 'This delivery has no stable event ID to redeliver');
  const order = d.prepare('SELECT * FROM orders WHERE id = ?').get(ev.order_id);
  const res = ingest({ store_id: ev.store_id, event_id: ev.event_id, shopify_order_id: order.shopify_order_id, event_type: ev.type }, { source: 'simulated' });
  if (res.event_ref) log(res.event_ref, user.id, 'simulation', `${user.name} simulated a redelivery of ${ev.event_id}`);
  return res;
}

module.exports = { ingest, retryResult, review, acknowledgeDuplicate, simulateRedelivery };
