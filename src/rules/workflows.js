'use strict';

// Required destination operations per workflow (spec §3). An event type must be
// defined here before OrderPilot will process it.

const WORKFLOWS = Object.freeze({
  created: {
    label: 'New order created',
    operations: [{ destination: 'airtable', kind: 'upsert' }],
  },
  cancelled: {
    label: 'Order cancelled',
    operations: [
      { destination: 'airtable', kind: 'cancel_update' },
      { destination: 'slack', kind: 'notify' },
    ],
  },
});

const DESTINATION_LABELS = { airtable: 'Airtable', slack: 'Slack' };
const KIND_LABELS = {
  upsert: 'order upsert',
  cancel_update: 'cancellation update',
  notify: 'cancellation notification',
};

function operationLabel(op) {
  return `${DESTINATION_LABELS[op.destination] || op.destination} ${KIND_LABELS[op.kind] || op.kind}`;
}

function targetRef(op, { shopifyOrderId, slackChannel }) {
  if (op.destination === 'airtable') return `Airtable Orders · record keyed by Shopify Order ID ${shopifyOrderId}`;
  if (op.destination === 'slack') return `Slack ${slackChannel}`;
  return op.destination;
}

module.exports = { WORKFLOWS, DESTINATION_LABELS, KIND_LABELS, operationLabel, targetRef };
