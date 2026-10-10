'use strict';

// Live-mode wiring with test credentials: embed token claims and the
// single-operation retry → callback round trip against a stub viaSocket flow.

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const received = [];
const stub = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => { received.push(JSON.parse(data)); res.writeHead(200).end('{}'); });
});

let base;
let server;

test.before(async () => {
  await new Promise((r) => stub.listen(0, r));
  Object.assign(process.env, {
    DB_FILE: ':memory:', SIM_DELAY_MS: '0', VIASOCKET_MODE: 'live',
    VIASOCKET_ORG_ID: 'org_test', VIASOCKET_PROJECT_ID: 'proj_test', VIASOCKET_EMBED_SECRET: 'access_test',
    VIASOCKET_WEBHOOK_SECRET: 'whsec', VIASOCKET_RETRY_SLACK_URL: `http://127.0.0.1:${stub.address().port}/slack`,
  });
  const { createApp } = require('../server');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => { server.close(); stub.close(); });

const call = async (path, { method = 'GET', body, actor = 'u_omar', headers = {} } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-actor': actor, ...headers }, body });
  return { status: res.status, body: await res.json() };
};
const signed = (obj) => {
  const raw = JSON.stringify(obj);
  return { body: raw, headers: { 'x-orderpilot-signature': crypto.createHmac('sha256', 'whsec').update(raw).digest('hex') } };
};

test('embed token is an HS256 JWT scoped to the store', async () => {
  const r = await call('/integrations/s_northstar/embed-token');
  assert.equal(r.status, 200);
  const [h, p, s] = r.body.token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.org_id, 'org_test');
  assert.equal(claims.project_id, 'proj_test');
  assert.equal(claims.unique_identifier, 'store_s_northstar');
  assert.deepEqual(Object.keys(claims).sort(), ['org_id', 'project_id', 'unique_identifier']); // no exp, per viaSocket
  const expected = crypto.createHmac('sha256', 'access_test').update(`${h}.${p}`).digest('base64url');
  assert.equal(s, expected);
  assert.equal((await call('/integrations/s_harbor/embed-token')).status, 403); // no permission
  assert.equal((await call('/integrations/s_northstar/embed-token', { actor: 'u_ines' })).status, 403);
});

test('live retry: only the failed op is sent; stays Retrying until callback confirms', async () => {
  const ing = await call('/webhooks/viasocket', { method: 'POST', ...signed({
    store_id: 's_northstar', event_id: 'shp_evt_live_9', shopify_order_id: '5800009999', event_type: 'cancelled',
    operations: [{ destination: 'airtable', result: 'success' }, { destination: 'slack', result: 'failed', detail: 'rate limited' }],
  }) });
  const id = ing.body.event_ref;
  const p = await call(`/issues/${id}/plan`, { method: 'POST' });
  const a = await call('/approvals', { method: 'POST', body: JSON.stringify({ event_ref: id, plan_hash: p.body.plan.plan_hash }) });
  const x = await call('/executions', { method: 'POST', body: JSON.stringify({ approval_id: a.body.approval.id }) });
  assert.equal(x.status, 202);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0].destination, 'slack');
  let i = (await call(`/issues/${id}`)).body;
  assert.equal(i.status, 'Retrying');
  // Concurrent retry is locked
  const p2 = await call(`/issues/${id}/plan`, { method: 'POST' });
  assert.equal(p2.body.plan.executable, false);
  const cb = await call('/webhooks/viasocket', { method: 'POST', ...signed({ attempt_key: received[0].attempt_key, result: 'success', execution_id: 'ex_42' }) });
  assert.equal(cb.body.recorded, 'success');
  i = (await call(`/issues/${id}`)).body;
  assert.equal(i.status, 'Resolved');
  const again = await call('/webhooks/viasocket', { method: 'POST', ...signed({ attempt_key: received[0].attempt_key, result: 'failed' }) });
  assert.equal(again.body.duplicate, true);
  assert.equal((await call(`/issues/${id}`)).body.status, 'Resolved');
});

test('live mode: synthetic demo events still use the simulated adapter', async () => {
  const before = received.length;
  const p = await call('/issues/ev_1013_created/plan', { method: 'POST' });
  const a = await call('/approvals', { method: 'POST', body: JSON.stringify({ event_ref: 'ev_1013_created', plan_hash: p.body.plan.plan_hash }) });
  await call('/executions', { method: 'POST', body: JSON.stringify({ approval_id: a.body.approval.id }) });
  assert.equal(received.length, before);
  assert.equal((await call('/issues/ev_1013_created')).body.status, 'Resolved');
});
