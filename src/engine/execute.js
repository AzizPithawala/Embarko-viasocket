'use strict';

// Approval and execution (spec §5–§7).
//  - One approval authorizes the displayed plan as a whole; each operation is
//    still tracked separately.
//  - Fresh approval is required immediately before every execution: approvals
//    are single-use and expire after APPROVAL_TTL_MS.
//  - Permission is re-checked right before execution; revocation blocks future
//    executions but never erases history. In-flight external actions are not
//    assumed to be cancellable.
//  - Only failed/pending required ops run; confirmed successes are preserved.
//  - An op with an attempt in flight is locked against concurrent retries.

const crypto = require('node:crypto');
const { get } = require('../db');
const { config } = require('../config');
const { getIssue } = require('../issues');
const { canExecute } = require('../actors');
const { buildPlan } = require('./plan');
const simulated = require('../adapters/simulated');
const viasocket = require('../adapters/viasocket');

const now = () => new Date().toISOString();

function log(eventRef, actor, kind, message) {
  get().prepare('INSERT INTO history (event_ref, at, actor, kind, message) VALUES (?, ?, ?, ?, ?)').run(eventRef, now(), actor, kind, message);
}

// Events reported by viaSocket recover through viaSocket; synthetic demo
// events always use the simulated adapter, even in live mode.
function adapterFor(event) {
  return event.source === 'viasocket' ? viasocket : simulated;
}

function err(status, error, extra) {
  return { status, error, ...extra };
}

function preparePlan(eventRef) {
  const issue = getIssue(eventRef);
  if (!issue) return err(404, 'Issue not found');
  return { status: 200, plan: buildPlan(issue), issue };
}

function approve(user, eventRef, planHash) {
  const prepared = preparePlan(eventRef);
  if (prepared.error) return prepared;
  const { plan } = prepared;
  const perm = canExecute(user, plan.store_id);
  if (!perm.ok) {
    log(eventRef, user ? user.id : 'unknown', 'blocked', `Approval refused: ${perm.reason}`);
    return err(403, perm.reason);
  }
  if (!plan.executable) return err(409, plan.blocked_reason, { plan });
  if (plan.plan_hash !== planHash) return err(409, 'The plan changed. Review the current plan and approve again.', { plan, plan_changed: true });

  const id = `apr_${crypto.randomUUID()}`;
  get().prepare('INSERT INTO approvals (id, actor_id, event_ref, plan_hash, plan_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, user.id, eventRef, plan.plan_hash, JSON.stringify(plan), now(),
  );
  log(eventRef, user.id, 'approval', `${user.name} approved plan ${plan.plan_hash}: ${plan.steps.map((s) => `${s.intent} ${s.label}`).join(', ')}`);
  return { status: 201, approval: { id, plan_hash: plan.plan_hash, expires_in_ms: config.approvalTtlMs } };
}

function execute(user, approvalId) {
  const d = get();
  const approval = d.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
  if (!approval) return err(404, 'Approval not found');
  if (approval.consumed_at) return err(409, 'This approval was already used. Fresh approval is required before every execution.');
  if (!user || approval.actor_id !== user.id) return err(403, 'Approval belongs to a different operator');
  if (Date.now() - Date.parse(approval.created_at) > config.approvalTtlMs) {
    return err(409, 'Approval expired. Fresh approval is required immediately before execution.');
  }

  const prepared = preparePlan(approval.event_ref);
  if (prepared.error) return prepared;
  const { plan, issue } = prepared;

  // Recheck permission immediately before execution (revocation policy).
  const perm = canExecute(user, plan.store_id);
  if (!perm.ok) {
    log(approval.event_ref, user.id, 'blocked', `Execution blocked at permission recheck: ${perm.reason}`);
    return err(403, perm.reason);
  }
  if (plan.in_flight.length) return err(409, 'An attempt is already in flight for this operation.', { plan });
  if (!plan.executable) return err(409, plan.blocked_reason, { plan });
  if (plan.plan_hash !== approval.plan_hash) {
    return err(409, 'The plan changed since approval. Review the current plan and approve again.', { plan, plan_changed: true });
  }

  const adapter = adapterFor(issue.event);
  const started = [];
  // Consume approval, lock ops and open attempts atomically.
  d.transaction(() => {
    const res = d.prepare('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now(), approvalId);
    if (res.changes !== 1) throw new Error('approval race');
    for (const step of plan.steps) {
      const lock = d.prepare("UPDATE operations SET state = 'retrying', updated_at = ? WHERE id = ? AND state IN ('failed', 'pending')").run(now(), step.operation_id);
      if (lock.changes !== 1) throw new Error('operation lock race');
      const n = d.prepare('SELECT COUNT(*) AS c FROM attempts WHERE operation_id = ?').get(step.operation_id).c + 1;
      const attemptKey = `${issue.event.event_id || issue.id}:${step.operation_id}:${n}`;
      const info = d.prepare(`INSERT INTO attempts (operation_id, n, started_at, approval_id, actor, source, kind, attempt_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(step.operation_id, n, now(), approvalId, user.id, adapter.name, step.intent, attemptKey);
      started.push({ step, attempt: { id: info.lastInsertRowid, n, attempt_key: attemptKey } });
      log(issue.id, user.id, 'execution', `Attempt ${n} · ${step.label} started (${step.intent}, ${adapter.name}) — ${step.reason}`);
    }
  })();

  const ctx = { event: issue.event, order: issue.order, store: d.prepare('SELECT * FROM stores WHERE id = ?').get(issue.event.store_id) };
  for (const { step, attempt } of started) {
    const op = d.prepare('SELECT * FROM operations WHERE id = ?').get(step.operation_id);
    adapter.run(op, attempt, (result, detail) => completeAttempt(attempt.id, result, detail), ctx);
  }
  return { status: 202, started: started.map((s) => ({ operation_id: s.step.operation_id, attempt: s.attempt.n })) };
}

// Record an attempt outcome. Never downgrades a confirmed success.
function completeAttempt(attemptId, result, detail, { executionId } = {}) {
  const d = get();
  const attempt = d.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt || attempt.result) return false;
  const op = d.prepare('SELECT * FROM operations WHERE id = ?').get(attempt.operation_id);
  if (!op) return false;
  const fullDetail = executionId ? `${detail} [viaSocket execution ${executionId}]` : detail;
  d.transaction(() => {
    d.prepare('UPDATE attempts SET result = ?, detail = ?, finished_at = ? WHERE id = ?').run(result, fullDetail, now(), attemptId);
    if (op.state !== 'success') {
      d.prepare('UPDATE operations SET state = ?, last_outcome = ?, updated_at = ? WHERE id = ?').run(result, fullDetail, now(), op.id);
    }
  })();
  log(op.event_ref, attempt.source === 'viasocket' ? 'viasocket' : 'system', 'attempt',
    `Attempt ${attempt.n} · ${op.destination} ${op.kind}: ${result} — ${fullDetail}`);
  return true;
}

// Inspect a destination for an unknown outcome (read-only; any role).
function inspect(user, operationId) {
  const d = get();
  const op = d.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
  if (!op) return err(404, 'Operation not found');
  if (op.state !== 'unknown') return err(409, 'Only unknown outcomes need inspection');
  const event = d.prepare('SELECT * FROM events WHERE id = ?').get(op.event_ref);
  const store = d.prepare('SELECT * FROM stores WHERE id = ?').get(event.store_id);
  const finding = adapterFor(event).inspect(op, store);
  if (!finding) return err(501, 'Live outcomes are reported by viaSocket. Check the viaSocket execution log; the result will arrive via webhook.');
  d.prepare('UPDATE operations SET state = ?, last_outcome = ?, updated_at = ? WHERE id = ?').run(finding.result, finding.detail, now(), op.id);
  d.prepare('UPDATE attempts SET detail = detail || ? WHERE operation_id = ? AND n = (SELECT MAX(n) FROM attempts WHERE operation_id = ?) AND result = ?')
    .run(` → verified ${finding.result === 'success' ? 'applied' : 'not applied'}`, op.id, op.id, 'unknown');
  log(op.event_ref, user.id, 'inspection', `${user.name} inspected ${op.destination} ${op.kind}: ${finding.detail}`);
  return { status: 200, result: finding.result, detail: finding.detail };
}

module.exports = { approve, execute, completeAttempt, inspect, preparePlan, log };
