'use strict';

const crypto = require('node:crypto');

// A recovery plan contains only the required operations that still need work
// (spec §5). Confirmed successes are preserved and never repeated; unknown
// outcomes must be verified before they can be retried.
//
// Plan identity = destination + operation + target + intent. The hash excludes
// attempt numbers, so a retry of the same op against the same target keeps the
// same identity — but fresh approval is still required before every execution.

function buildPlan(issue) {
  const ev = issue.event;
  const ops = issue.operations.filter((op) => op.required);
  const plan = {
    event_ref: issue.id,
    store_id: ev.store_id,
    store_name: issue.store.name,
    order_number: issue.order.order_number,
    workflow: issue.workflow,
    steps: [],
    preserved: [],
    verify_first: [],
    in_flight: [],
    blocked_reason: null,
  };

  if (ev.identity === 'uncertain') {
    plan.blocked_reason = 'Event identity is uncertain. Review the evidence and classify it before any processing.';
  } else if (ev.identity === 'duplicate') {
    plan.blocked_reason = 'Duplicate delivery — linked to existing history. Nothing to process.';
  }

  for (const op of ops) {
    const item = { operation_id: op.id, destination: op.destination, kind: op.kind, label: op.label, target_ref: op.target_ref };
    if (op.state === 'success') plan.preserved.push({ ...item, note: 'Confirmed successful — will not be repeated' });
    else if (op.state === 'unknown') plan.verify_first.push({ ...item, note: 'Outcome unknown — inspect the destination before retrying' });
    else if (op.state === 'retrying') plan.in_flight.push({ ...item, note: 'Attempt in flight — wait for its outcome' });
    else if (!plan.blocked_reason) {
      const intent = op.state === 'pending' ? 'process' : 'retry';
      plan.steps.push({
        ...item,
        intent,
        next_attempt: op.attempts.length + 1,
        reason: intent === 'retry' ? `Confirmed failure: ${op.last_outcome}` : 'Not yet processed',
      });
    }
  }

  if (!plan.blocked_reason && plan.steps.length === 0) {
    if (plan.in_flight.length) plan.blocked_reason = 'An attempt is already in flight for this issue.';
    else if (plan.verify_first.length) plan.blocked_reason = 'Verify the unknown outcome first; it may already have been applied.';
    else plan.blocked_reason = 'All required operations are confirmed successful.';
  }
  plan.executable = !plan.blocked_reason && plan.in_flight.length === 0;
  plan.plan_hash = hashPlan(plan);
  return plan;
}

function hashPlan(plan) {
  const identity = plan.steps.map((s) => [s.operation_id, s.destination, s.kind, s.target_ref, s.intent]);
  return crypto.createHash('sha256').update(JSON.stringify({ e: plan.event_ref, identity })).digest('hex').slice(0, 16);
}

module.exports = { buildPlan, hashPlan };
