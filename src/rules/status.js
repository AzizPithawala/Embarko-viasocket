'use strict';

// Overall sync status is derived from the required destination operations of
// one event (spec §3). It is never edited directly.
//
// Precedence:
//   1. any required op with a confirmed failure        -> Failed
//   2. any required op actively being retried          -> Retrying
//   3. any required op unknown / pending, or identity
//      still awaiting review                           -> Unresolved
//   4. every required op confirmed successful          -> Resolved

const STATUS = Object.freeze({
  FAILED: 'Failed',
  RETRYING: 'Retrying',
  UNRESOLVED: 'Unresolved',
  RESOLVED: 'Resolved',
});

function deriveOverallStatus(operations, { identityPending = false } = {}) {
  const required = operations.filter((op) => op.required);
  if (required.some((op) => op.state === 'failed')) return STATUS.FAILED;
  if (required.some((op) => op.state === 'retrying')) return STATUS.RETRYING;
  if (identityPending) return STATUS.UNRESOLVED;
  if (required.length === 0) return STATUS.RESOLVED;
  if (required.every((op) => op.state === 'success')) return STATUS.RESOLVED;
  return STATUS.UNRESOLVED;
}

module.exports = { STATUS, deriveOverallStatus };
