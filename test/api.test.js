'use strict';

process.env.DB_FILE = ':memory:';
process.env.SIM_DELAY_MS = '0';
process.env.VIASOCKET_WEBHOOK_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../server');
const db = require('../src/db');

let base;
let server;

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());
// Demo reset never touches live stores, so tests that add one purge it here.
function purgeLiveStores() {
  const d = db.get();
  const live = "SELECT id FROM stores WHERE kind = 'live'";
  const liveEvents = `SELECT id FROM events WHERE store_id IN (${live})`;
  d.prepare(`DELETE FROM attempts WHERE operation_id IN (SELECT id FROM operations WHERE event_ref IN (${liveEvents}))`).run();
  for (const t of ['operations', 'approvals']) d.prepare(`DELETE FROM ${t} WHERE event_ref IN (${liveEvents})`).run();
  d.prepare(`DELETE FROM history WHERE store_id IN (${live}) OR event_ref IN (${liveEvents})`).run();
  for (const t of ['events', 'orders', 'permissions']) d.prepare(`DELETE FROM ${t} WHERE store_id IN (${live})`).run();
  d.prepare("DELETE FROM stores WHERE kind = 'live'").run();
}
test.beforeEach(() => { purgeLiveStores(); db.resetAll(); });

async function call(path, { method = 'GET', body, actor = 'u_omar', headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-actor': actor, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Prepare plan, approve fresh, execute. Returns execute response.
async function recover(eventRef, actor = 'u_omar') {
  const p = await call(`/issues/${eventRef}/plan`, { method: 'POST', actor });
  const a = await call('/approvals', { method: 'POST', actor, body: { event_ref: eventRef, plan_hash: p.body.plan.plan_hash } });
  if (a.status !== 201) return a;
  return call('/executions', { method: 'POST', actor, body: { approval_id: a.body.approval.id } });
}

const issue = async (id) => (await call(`/issues/${id}`)).body;
const op = (i, dest) => i.operations.find((o) => o.destination === dest);

test('dashboard is populated and counts derive from the same data', async () => {
  const { body } = await call('/issues');
  assert.equal(body.counts.orders, 20);
  assert.equal(body.counts.open, body.issues.length);
  assert.equal(body.counts.open, body.counts.investigate_now + body.counts.action_required + body.counts.monitor);
  const ranks = body.issues.map((i) => i.priority.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  const filtered = await call('/issues?store=s_studio');
  assert.ok(filtered.body.issues.every((i) => i.store.id === 's_studio'));
});

test('Scenario A: Fail → Fail → Succeed with fresh approval each time, all attempts kept', async () => {
  const id = 'ev_1004_created';
  let r = await recover(id);
  assert.equal(r.status, 202);
  let i = await issue(id);
  assert.equal(i.status, 'Failed');
  r = await recover(id);
  assert.equal(r.status, 202);
  i = await issue(id);
  assert.equal(i.status, 'Resolved');
  assert.deepEqual(op(i, 'airtable').attempts.map((a) => a.result), ['failed', 'failed', 'success']);
  const list = await call('/issues');
  assert.ok(!list.body.issues.some((x) => x.id === id));
  assert.ok(list.body.resolved.some((x) => x.id === id));
});

test('approval is single use and cannot be replayed', async () => {
  const id = 'ev_1004_created';
  const p = await call(`/issues/${id}/plan`, { method: 'POST' });
  const a = await call('/approvals', { method: 'POST', body: { event_ref: id, plan_hash: p.body.plan.plan_hash } });
  assert.equal((await call('/executions', { method: 'POST', body: { approval_id: a.body.approval.id } })).status, 202);
  const again = await call('/executions', { method: 'POST', body: { approval_id: a.body.approval.id } });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Fresh approval/);
});

test('stale plan hash is rejected and the current plan returned', async () => {
  const r = await call('/approvals', { method: 'POST', body: { event_ref: 'ev_1004_created', plan_hash: 'not-the-plan' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.plan_changed, true);
  assert.ok(r.body.plan.plan_hash);
});

test('Scenario B: unknown stays Unresolved until inspected; confirmed by inspection resolves', async () => {
  const id = 'ev_1006_created';
  let i = await issue(id);
  assert.equal(i.status, 'Unresolved');
  const p = await call(`/issues/${id}/plan`, { method: 'POST' });
  assert.equal(p.body.plan.executable, false);
  assert.equal(p.body.plan.verify_first.length, 1);
  await call(`/operations/${op(i, 'airtable').id}/inspect`, { method: 'POST', actor: 'u_ines' });
  i = await issue(id);
  assert.equal(i.status, 'Resolved');
  assert.equal(op(i, 'airtable').attempts.length, 1); // nothing re-sent
});

test('Scenario B (not applied): inspection confirms failure, then safe retry resolves', async () => {
  const id = 'ev_1014_created';
  const i = await issue(id);
  await call(`/operations/${op(i, 'airtable').id}/inspect`, { method: 'POST' });
  assert.equal((await issue(id)).status, 'Failed');
  assert.equal((await recover(id)).status, 202);
  assert.equal((await issue(id)).status, 'Resolved');
});

test('cancellation: confirmed Airtable success preserved, only Slack retried', async () => {
  const id = 'ev_1007_cancelled';
  const before = await issue(id);
  assert.equal(before.order.shopify_status, 'Cancelled');
  assert.equal(before.status, 'Failed');
  const p = await call(`/issues/${id}/plan`, { method: 'POST' });
  assert.deepEqual(p.body.plan.steps.map((s) => s.destination), ['slack']);
  assert.deepEqual(p.body.plan.preserved.map((s) => s.destination), ['airtable']);
  await recover(id);
  const after = await issue(id);
  assert.equal(after.status, 'Resolved');
  assert.equal(op(after, 'airtable').attempts.length, 1);
  assert.equal(op(after, 'slack').attempts.length, 2);
});

test('cancellation with failed Airtable + unknown Slack: Failed; Slack verified, never resent', async () => {
  const id = 'ev_1020_cancelled';
  let i = await issue(id);
  assert.equal(i.status, 'Failed');
  assert.equal(i.priority.label, 'Investigate now');
  const p = await call(`/issues/${id}/plan`, { method: 'POST', actor: 'u_ada' });
  assert.deepEqual(p.body.plan.steps.map((s) => s.destination), ['airtable']);
  await call(`/operations/${op(i, 'slack').id}/inspect`, { method: 'POST', actor: 'u_ada' });
  assert.equal((await recover(id, 'u_ada')).status, 202);
  i = await issue(id);
  assert.equal(i.status, 'Resolved');
  assert.equal(op(i, 'slack').attempts.length, 1);
});

test('Scenario C: duplicate delivery links to history and creates no operations', async () => {
  const r = await call('/events/ev_1001_created/redeliver', { method: 'POST' });
  assert.equal(r.body.classification, 'duplicate');
  const dup = await issue(r.body.event_ref);
  assert.equal(dup.operations.length, 0);
  assert.equal(dup.duplicate_of.id, 'ev_1001_created');
  const orig = await issue('ev_1001_created');
  assert.equal(op(orig, 'airtable').attempts.length, 1);
  assert.ok(orig.history.some((h) => h.kind === 'duplicate'));
  await call(`/events/${r.body.event_ref}/acknowledge`, { method: 'POST' });
  assert.equal((await issue(r.body.event_ref)).priority, null);
});

test('Scenario D: persistent failure stays Failed and escalates to manual review', async () => {
  const id = 'ev_1012_created';
  await recover(id);
  await recover(id);
  const i = await issue(id);
  assert.equal(i.status, 'Failed');
  assert.match(i.priority.reason, /Manual review/);
  assert.equal(op(i, 'airtable').attempts.length, 3);
});

test('uncertain event: review as new → plan → fresh approval → processed', async () => {
  const id = 'ev_1019_created_d1';
  let i = await issue(id);
  assert.equal(i.priority.label, 'Investigate now');
  assert.equal(i.review.closest_match.id, 'ev_1019_created');
  assert.equal(i.review.side_effects_may_have_occurred, true);
  const p0 = await call(`/issues/${id}/plan`, { method: 'POST', actor: 'u_ada' });
  assert.equal(p0.body.plan.executable, false);
  const rv = await call(`/events/${id}/review`, { method: 'POST', actor: 'u_ines', body: { decision: 'new', rationale: 'Different payload timestamp; Shopify re-export' } });
  assert.equal(rv.status, 200);
  i = await issue(id);
  assert.equal(op(i, 'airtable').state, 'pending');
  assert.equal((await recover(id, 'u_ada')).status, 202);
  i = await issue(id);
  assert.equal(i.status, 'Resolved');
  assert.ok(i.history.some((h) => h.kind === 'review' && /Different payload/.test(h.message)));
});

test('uncertain event classified as duplicate links without processing', async () => {
  const id = 'ev_1019_created_d1';
  await call(`/events/${id}/review`, { method: 'POST', actor: 'u_ines', body: { decision: 'duplicate', rationale: 'Same order, same minute' } });
  const i = await issue(id);
  assert.equal(i.event.identity, 'duplicate');
  assert.equal(i.operations.length, 0);
  assert.equal(i.priority, null);
});

test('roles: investigator cannot approve; operator blocked on a store without permission', async () => {
  const p = await call('/issues/ev_1004_created/plan', { method: 'POST', actor: 'u_ines' });
  assert.equal(p.body.can_execute, false);
  const a = await call('/approvals', { method: 'POST', actor: 'u_ines', body: { event_ref: 'ev_1004_created', plan_hash: p.body.plan.plan_hash } });
  assert.equal(a.status, 403);
  const h = await recover('ev_1018_created', 'u_omar'); // Harbor & Pine
  assert.equal(h.status, 403);
});

test('revocation between approval and execution blocks execution; history kept', async () => {
  const id = 'ev_1004_created';
  const p = await call(`/issues/${id}/plan`, { method: 'POST' });
  const a = await call('/approvals', { method: 'POST', body: { event_ref: id, plan_hash: p.body.plan.plan_hash } });
  assert.equal(a.status, 201);
  assert.equal((await call('/permissions', { method: 'POST', actor: 'u_omar', body: { user_id: 'u_omar', store_id: 's_northstar', grant: false } })).status, 403);
  await call('/permissions', { method: 'POST', actor: 'u_ada', body: { user_id: 'u_omar', store_id: 's_northstar', grant: false } });
  const x = await call('/executions', { method: 'POST', body: { approval_id: a.body.approval.id } });
  assert.equal(x.status, 403);
  const i = await issue(id);
  assert.ok(i.history.some((h) => h.kind === 'approval'));
  assert.ok(i.history.some((h) => h.kind === 'blocked'));
  assert.equal(op(i, 'airtable').attempts.length, 1);
});

test('per-issue reset restores baseline without touching others; replay has no duplicate history', async () => {
  const baseline = (await call('/issues')).body.counts;
  await recover('ev_1004_created');
  await recover('ev_1004_created');
  await recover('ev_1013_created');
  await call('/reset/order/o_1004', { method: 'POST' });
  const i = await issue('ev_1004_created');
  assert.equal(i.status, 'Failed');
  assert.equal(op(i, 'airtable').attempts.length, 1);
  assert.equal((await issue('ev_1013_created')).status, 'Resolved');
  const h1 = i.history.length;
  await recover('ev_1004_created');
  await recover('ev_1004_created');
  await call('/reset/order/o_1004', { method: 'POST' });
  assert.equal((await issue('ev_1004_created')).history.length, h1);
  await call('/reset/all', { method: 'POST', body: { confirm: 'RESET' } });
  assert.deepEqual((await call('/issues')).body.counts, baseline);
});

test('full reset requires explicit confirmation', async () => {
  assert.equal((await call('/reset/all', { method: 'POST', body: {} })).status, 400);
});

function signed(body) {
  const raw = JSON.stringify(body);
  return { body: raw, headers: { 'x-orderpilot-signature': crypto.createHmac('sha256', 'test-secret').update(raw).digest('hex') } };
}

test('webhook: rejects bad signature; ingests, dedups and flags missing IDs', async () => {
  const payload = {
    store_id: 's_studio', event_id: 'shp_evt_live_1', shopify_order_id: '5899990001', event_type: 'cancelled',
    operations: [{ destination: 'airtable', result: 'success', execution_id: 'ex1' }, { destination: 'slack', result: 'failed', detail: 'channel archived' }],
  };
  assert.equal((await call('/webhooks/viasocket', { method: 'POST', body: JSON.stringify(payload), headers: { 'x-orderpilot-signature': 'bad' } })).status, 401);
  const first = await call('/webhooks/viasocket', { method: 'POST', ...signed(payload) });
  assert.equal(first.body.classification, 'new');
  const i = await issue(first.body.event_ref);
  assert.equal(i.status, 'Failed');
  assert.equal(i.order.shopify_status, 'Cancelled');
  const second = await call('/webhooks/viasocket', { method: 'POST', ...signed(payload) });
  assert.equal(second.body.classification, 'duplicate');
  assert.equal(second.body.duplicate_of, first.body.event_ref);
  assert.equal(op(await issue(first.body.event_ref), 'airtable').attempts.length, 1);
  const other = await call('/webhooks/viasocket', { method: 'POST', ...signed({ ...payload, store_id: 's_northstar' }) });
  assert.equal(other.body.classification, 'new');
  const noId = await call('/webhooks/viasocket', { method: 'POST', ...signed({ ...payload, event_id: undefined }) });
  assert.equal(noId.body.classification, 'uncertain');
  assert.equal(noId.body.closest_match, first.body.event_ref);
});

test('embed token requires live configuration', async () => {
  const r = await call('/integrations/s_northstar/embed-token');
  assert.equal(r.status, 503);
});

// ---------- Phase 1.3: live stores, bearer webhook auth, per-store report URL, live/demo filter ----------

const LIVE_STORE = { name: 'Acme Apparel', slack_channel: '#acme-orders', shopify_domain: 'acme-test.myshopify.com', airtable_base: 'appABCDEFGHIJKLMN', airtable_table: 'Orders' };
const bearer = { authorization: 'Bearer test-secret' };

test('stores: only admins add live stores; input is validated; creator can execute', async () => {
  assert.equal((await call('/stores', { method: 'POST', body: LIVE_STORE })).status, 403); // operator
  assert.equal((await call('/stores', { method: 'POST', actor: 'u_ada', body: { ...LIVE_STORE, slack_channel: 'acme' } })).status, 400);
  assert.equal((await call('/stores', { method: 'POST', actor: 'u_ada', body: { ...LIVE_STORE, shopify_domain: 'acme.com' } })).status, 400);
  assert.equal((await call('/stores', { method: 'POST', actor: 'u_ada', body: { ...LIVE_STORE, airtable_base: 'base1' } })).status, 400);
  const r = await call('/stores', { method: 'POST', actor: 'u_ada', body: LIVE_STORE });
  assert.equal(r.status, 201);
  assert.equal(r.body.store.id, 's_acme_apparel');
  assert.equal(r.body.store.kind, 'live');
  assert.equal((await call('/stores', { method: 'POST', actor: 'u_ada', body: LIVE_STORE })).status, 409); // same Shopify domain
  const team = (await call('/team')).body.users;
  assert.ok(team.find((u) => u.id === 'u_ada').stores.includes('s_acme_apparel'));
  assert.ok(!team.find((u) => u.id === 'u_omar').stores.includes('s_acme_apparel'));
  assert.equal((await call('/meta')).body.has_live_stores, true);
});

test('demo reset keeps live stores, their orders, permissions and history', async () => {
  await call('/stores', { method: 'POST', actor: 'u_ada', body: LIVE_STORE });
  const ing = await call('/webhooks/viasocket/stores/s_acme_apparel', { method: 'POST', headers: bearer, body: {
    event_id: 'evt_live_keep', shopify_order_id: '7000000001', event_type: 'created',
    operations: [{ destination: 'airtable', result: 'failed', detail: 'Unknown field "Total"' }],
  } });
  assert.equal(ing.body.classification, 'new');
  assert.equal((await call('/reset/all', { method: 'POST', body: { confirm: 'RESET' } })).status, 200);
  const meta = (await call('/meta')).body;
  assert.ok(meta.stores.some((s) => s.id === 's_acme_apparel' && s.kind === 'live'));
  assert.ok(meta.users.find((u) => u.id === 'u_ada').stores.includes('s_acme_apparel'));
  assert.equal((await issue(ing.body.event_ref)).status, 'Failed');
  const acts = (await call('/activity')).body.activity;
  assert.ok(acts.some((a) => a.message.includes('added live client store Acme Apparel')));
});

test('webhook: bearer token is accepted as an alternative to the HMAC signature', async () => {
  const body = { store_id: 's_studio', event_id: 'evt_bearer_1', shopify_order_id: '5899990077', event_type: 'created',
    operations: [{ destination: 'airtable', result: 'success' }] };
  assert.equal((await call('/webhooks/viasocket', { method: 'POST', body })).status, 401);
  assert.equal((await call('/webhooks/viasocket', { method: 'POST', body, headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call('/webhooks/viasocket', { method: 'POST', body, headers: { authorization: 'test-secret' } })).status, 401);
  const ok = await call('/webhooks/viasocket', { method: 'POST', body, headers: bearer });
  assert.equal(ok.body.classification, 'new');
});

test('webhook: per-store URL fixes the store; a conflicting store_id is rejected', async () => {
  const body = { event_id: 'evt_path_1', shopify_order_id: '5899990088', event_type: 'created', operations: [{ destination: 'airtable', result: 'success' }] };
  const ok = await call('/webhooks/viasocket/stores/s_studio', { method: 'POST', body, headers: bearer });
  assert.equal(ok.body.classification, 'new');
  assert.equal((await issue(ok.body.event_ref)).store.id, 's_studio');
  const clash = await call('/webhooks/viasocket/stores/s_studio', { method: 'POST', body: { ...body, store_id: 's_harbor' }, headers: bearer });
  assert.equal(clash.status, 400);
  assert.equal((await call('/webhooks/viasocket/stores/s_nope', { method: 'POST', body, headers: bearer })).status, 400);
  assert.equal((await call('/webhooks/viasocket/stores/s_studio', { method: 'POST', body })).status, 401);
});

test('dashboard filter: live and demo stores are separated', async () => {
  await call('/stores', { method: 'POST', actor: 'u_ada', body: LIVE_STORE });
  const ing = await call('/webhooks/viasocket/stores/s_acme_apparel', { method: 'POST', headers: bearer, body: {
    event_id: 'evt_live_f', shopify_order_id: '7000000002', event_type: 'created',
    operations: [{ destination: 'airtable', result: 'failed', detail: 'rate limited' }],
  } });
  const live = (await call('/issues?kind=live')).body;
  assert.deepEqual(live.issues.map((i) => i.id), [ing.body.event_ref]);
  assert.equal(live.issues[0].store.kind, 'live');
  const demo = (await call('/issues?kind=demo')).body;
  assert.ok(demo.issues.length > 0 && demo.issues.every((i) => i.store.kind === 'demo'));
  const all = (await call('/issues')).body;
  assert.equal(all.counts.open, live.counts.open + demo.counts.open);
  const integ = (await call('/integrations')).body;
  assert.match(integ.stores.find((s) => s.id === 's_acme_apparel').report_url, /\/api\/webhooks\/viasocket\/stores\/s_acme_apparel$/);
});
