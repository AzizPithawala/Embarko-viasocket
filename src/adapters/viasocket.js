'use strict';

// Live adapter (VIASOCKET_MODE=live). A retry triggers a single-operation
// viaSocket flow through its webhook URL. Acceptance by viaSocket is NOT proof
// of success: the attempt stays in flight until the flow reports its result to
// POST /api/webhooks/viasocket with the same attempt_key.

const { config } = require('../config');

function retryUrl(destination) {
  return destination === 'airtable' ? config.viasocket.retryAirtableUrl : destination === 'slack' ? config.viasocket.retrySlackUrl : '';
}

function run(op, attempt, complete, ctx) {
  const url = retryUrl(op.destination);
  if (!url) {
    complete('failed', `No viaSocket retry flow configured for ${op.destination} (set VIASOCKET_RETRY_${op.destination.toUpperCase()}_URL). Nothing was sent.`);
    return;
  }
  const body = {
    attempt_key: attempt.attempt_key,
    operation_id: op.id,
    destination: op.destination,
    kind: op.kind,
    target_ref: op.target_ref,
    store_id: ctx.store.id,
    event_id: ctx.event.event_id,
    event_type: ctx.event.type,
    shopify_order_id: ctx.order.shopify_order_id,
    order_number: ctx.order.order_number,
    slack_channel: ctx.store.slack_channel,
    callback_url: config.publicUrl ? `${config.publicUrl}/api/webhooks/viasocket` : null,
  };
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
    .then((res) => {
      // 2xx: flow accepted. Outcome arrives later via the callback webhook.
      if (!res.ok) complete('failed', `viaSocket rejected the retry trigger (HTTP ${res.status}); flow did not start`);
    })
    .catch((err) => {
      // We cannot tell whether the flow started: outcome is unknown.
      complete('unknown', `viaSocket trigger request failed (${err.name}) — outcome unknown; check the viaSocket execution log`);
    });
}

function inspect() {
  return null; // live outcomes are reported by viaSocket via the webhook
}

module.exports = { name: 'viasocket', run, inspect };
