'use strict';

const express = require('express');
const db = require('../db');
const { config } = require('../config');
const { listIssues, getIssue, activity } = require('../issues');
const { actorFrom, canExecute, listUsersWithPermissions, setPermission } = require('../actors');
const engine = require('../engine/execute');
const ingest = require('../engine/ingest');
const { embedTokenForStore, storeUserId, verifySignature } = require('../viasocket/embedToken');

const router = express.Router();

// Raw body is kept for webhook signature verification.
router.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

router.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/') || req.path === '/health') return next();
  req.actor = actorFrom(req);
  if (!req.actor) return res.status(401).json({ error: 'Unknown simulated user' });
  next();
});

const send = (res, out) => {
  const { status = 200, ...body } = out;
  res.status(status).json(body);
};

router.get('/health', (_req, res) => res.json({ ok: true }));

router.get('/meta', (req, res) => {
  const d = db.get();
  res.json({
    mode: config.viasocket.mode,
    simulation: true,
    actor: req.actor,
    users: listUsersWithPermissions(),
    stores: d.prepare('SELECT * FROM stores ORDER BY name').all(),
    approval_ttl_ms: config.approvalTtlMs,
  });
});

// Issues dashboard and investigation panel
router.get('/issues', (req, res) => res.json(listIssues({ store: req.query.store || undefined, status: req.query.status || undefined })));

router.get('/issues/:id', (req, res) => {
  const issue = getIssue(req.params.id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  const exec = canExecute(req.actor, issue.event.store_id);
  res.json({ ...issue, can_execute: exec.ok, execute_reason: exec.ok ? null : exec.reason });
});

router.get('/activity', (req, res) => res.json({ activity: activity({ store: req.query.store || undefined }) }));

// Recovery: plan → fresh approval → execution
router.post('/issues/:id/plan', (req, res) => {
  const out = engine.preparePlan(req.params.id);
  if (out.error) return send(res, out);
  const exec = canExecute(req.actor, out.plan.store_id);
  res.json({ plan: out.plan, can_execute: exec.ok, execute_reason: exec.ok ? null : exec.reason });
});
router.post('/approvals', (req, res) => send(res, engine.approve(req.actor, req.body.event_ref, req.body.plan_hash)));
router.post('/executions', (req, res) => send(res, engine.execute(req.actor, req.body.approval_id)));
router.post('/operations/:id/inspect', (req, res) => send(res, engine.inspect(req.actor, req.params.id)));

// Identity review and duplicates
router.post('/events/:id/review', (req, res) => send(res, ingest.review(req.actor, req.params.id, req.body.decision, req.body.rationale)));
router.post('/events/:id/acknowledge', (req, res) => send(res, ingest.acknowledgeDuplicate(req.actor, req.params.id)));
router.post('/events/:id/redeliver', (req, res) => send(res, ingest.simulateRedelivery(req.actor, req.params.id)));

// Team permissions (admin only)
router.get('/team', (_req, res) => res.json({ users: listUsersWithPermissions() }));
router.post('/permissions', (req, res) => send(res, setPermission(req.actor, req.body.user_id, req.body.store_id, req.body.grant !== false)));

// Demo resets
router.post('/reset/order/:orderId', (req, res) => {
  if (!db.resetOrder(req.params.orderId, req.actor.id)) return res.status(404).json({ error: 'Unknown order' });
  res.json({ ok: true });
});
router.post('/reset/all', (req, res) => {
  if (req.body.confirm !== 'RESET') return res.status(400).json({ error: 'Confirmation required: send {"confirm":"RESET"}' });
  db.resetAll();
  res.json({ ok: true });
});

// viaSocket Embed
router.get('/integrations', (req, res) => {
  const vs = config.viasocket;
  const d = db.get();
  res.json({
    mode: vs.mode,
    embed_configured: vs.embedConfigured,
    embed_script_url: vs.embedScriptUrl,
    webhook_url: `${config.publicUrl || `${req.protocol}://${req.get('host')}`}/api/webhooks/viasocket`,
    webhook_signed: !!vs.webhookSecret,
    retry_flows: { airtable: !!vs.retryAirtableUrl, slack: !!vs.retrySlackUrl },
    stores: d.prepare('SELECT id, name FROM stores ORDER BY name').all().map((s) => ({ ...s, viasocket_user_id: storeUserId(s.id) })),
  });
});

router.get('/integrations/:storeId/embed-token', (req, res) => {
  const vs = config.viasocket;
  if (vs.mode !== 'live' || !vs.embedConfigured) {
    return res.status(503).json({ error: 'viaSocket Embed is not configured. Set VIASOCKET_MODE=live, VIASOCKET_ORG_ID, VIASOCKET_PROJECT_ID and VIASOCKET_ACCESS_KEY.' });
  }
  if (req.actor.role === 'investigator') return res.status(403).json({ error: 'Investigators cannot manage integrations' });
  const exec = canExecute(req.actor, req.params.storeId);
  if (!exec.ok) return res.status(403).json({ error: exec.reason });
  res.json({ token: embedTokenForStore(req.params.storeId), user_id: storeUserId(req.params.storeId), script_url: vs.embedScriptUrl });
});

// Inbound reports from viaSocket flows
router.post('/webhooks/viasocket', (req, res) => {
  const vs = config.viasocket;
  if (vs.webhookSecret) {
    if (!verifySignature(req.rawBody || Buffer.alloc(0), req.get('x-orderpilot-signature'), vs.webhookSecret)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else if (vs.mode === 'live') {
    return res.status(503).json({ error: 'VIASOCKET_WEBHOOK_SECRET must be set in live mode' });
  }
  const body = req.body || {};
  if (body.attempt_key) return send(res, ingest.retryResult(body));
  // In simulated mode, unsigned test deliveries never drive real retry flows.
  return send(res, ingest.ingest(body, { source: vs.mode === 'live' ? 'viasocket' : 'webhook-test' }));
});

module.exports = router;
