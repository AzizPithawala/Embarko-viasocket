'use strict';

// Deterministic simulated destinations. Each operation has a scripted list of
// outcomes for its future attempts (the last entry repeats), so every demo run
// is repeatable — never random.

const { get } = require('../db');

const DETAILS = {
  airtable: {
    success: { upsert: 'Airtable record upserted by Shopify Order ID (simulated)', cancel_update: 'Airtable record marked Cancelled (simulated)' },
    failed: 'Airtable API 503 Service Unavailable (simulated)',
    unknown: 'Airtable request timed out — outcome unknown (simulated)',
  },
  slack: {
    success: { notify: 'Slack cancellation message posted (simulated)' },
    failed: 'Slack channel_not_found (simulated)',
    unknown: 'Slack request timed out — outcome unknown (simulated)',
  },
};

function delayMs() {
  const v = process.env.SIM_DELAY_MS;
  return v === undefined ? 1500 : Number(v);
}

function nextOutcome(op) {
  const script = JSON.parse(op.script || '[]');
  const result = script.length ? script[Math.min(op.script_pos, script.length - 1)] : 'success';
  get().prepare('UPDATE operations SET script_pos = script_pos + 1 WHERE id = ?').run(op.id);
  const d = DETAILS[op.destination] || DETAILS.airtable;
  const detail = result === 'success' ? d.success[op.kind] || 'Succeeded (simulated)' : d[result];
  return { result, detail };
}

// complete(result, detail) records the outcome; called after a short delay so
// the UI can show the "Retrying" state.
function run(op, _attempt, complete) {
  const outcome = nextOutcome(op);
  const ms = delayMs();
  if (ms <= 0) complete(outcome.result, outcome.detail);
  else setTimeout(() => complete(outcome.result, outcome.detail), ms);
}

// Inspect a destination for an unknown outcome (spec Scenario B).
function inspect(op, store) {
  if (op.inspect_result === 'success') {
    return {
      result: 'success',
      detail: op.destination === 'slack'
        ? `Inspection: message found in ${store.slack_channel} — notification already delivered; it will not be resent (simulated)`
        : 'Inspection: Airtable record found with expected values — the timed-out attempt did apply (simulated)',
    };
  }
  return {
    result: 'failed',
    detail: op.destination === 'slack'
      ? `Inspection: no message found in ${store.slack_channel} — confirmed not delivered (simulated)`
      : 'Inspection: no Airtable record for this Shopify Order ID — confirmed not applied (simulated)',
  };
}

module.exports = { name: 'simulated', run, inspect };
