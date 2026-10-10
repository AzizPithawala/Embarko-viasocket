'use strict';

const { operationLabel } = require('./workflows');

// Priority is separate from sync status (spec §3, §9): a label plus a short
// reason, recalculated whenever issue state changes.

const PRIORITY = Object.freeze({
  INVESTIGATE: { rank: 1, label: 'Investigate now' },
  ACTION: { rank: 2, label: 'Action required' },
  MONITOR: { rank: 3, label: 'Monitor' },
});

// A failed op is escalated to manual review once this many retries have failed.
const MANUAL_REVIEW_AFTER_FAILED_RETRIES = 2;

function make(p, reason) {
  return { rank: p.rank, label: p.label, reason };
}

// issue: { identity, acknowledged, operations: [{ state, required, destination, kind, attempts: [{result}] }] }
// Returns null when there is nothing to prioritise (resolved, no open item).
function derivePriority(issue) {
  const required = issue.operations.filter((op) => op.required);

  if (issue.identity === 'uncertain') {
    return make(PRIORITY.INVESTIGATE, 'Event identity uncertain — possible duplicate side effects');
  }
  const unknown = required.find((op) => op.state === 'unknown');
  if (unknown) {
    return make(PRIORITY.INVESTIGATE, `${operationLabel(unknown)} outcome unconfirmed`);
  }
  const failed = required.find((op) => op.state === 'failed');
  if (failed) {
    const failedRetries = (failed.attempts || []).filter((a) => a.result === 'failed').length - 1;
    if (failedRetries >= MANUAL_REVIEW_AFTER_FAILED_RETRIES) {
      return make(PRIORITY.ACTION, `Manual review — ${operationLabel(failed)} keeps failing`);
    }
    return make(PRIORITY.ACTION, `${operationLabel(failed)} failed`);
  }
  const pending = required.find((op) => op.state === 'pending');
  if (pending) {
    return make(PRIORITY.ACTION, `${operationLabel(pending)} awaiting approved processing`);
  }
  const retrying = required.find((op) => op.state === 'retrying');
  if (retrying) {
    return make(PRIORITY.MONITOR, `Retrying ${operationLabel(retrying)} — awaiting confirmation`);
  }
  if (issue.identity === 'duplicate' && !issue.acknowledged) {
    return make(PRIORITY.MONITOR, 'Duplicate delivery linked to existing history — nothing repeated');
  }
  return null;
}

module.exports = { PRIORITY, derivePriority, MANUAL_REVIEW_AFTER_FAILED_RETRIES };
