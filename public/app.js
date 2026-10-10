'use strict';

// OrderPilot UI. Plain JS, no build step. All state comes from the API; the UI
// never computes statuses, priorities or totals on its own.

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const state = {
  actor: store.get('op.actor', 'u_omar'),
  meta: null,
  view: 'issues',
  openIssue: null,
  issueData: null,
  list: null,
  pollTimer: null,
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-actor': state.actor },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data };
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

const stateLabel = { success: 'Confirmed success', failed: 'Failed', unknown: 'Outcome unknown', retrying: 'Retrying…', pending: 'Pending' };
const userName = (id) => (state.meta?.users.find((u) => u.id === id)?.name) || id;

// ---------- boot ----------
async function boot() {
  const { data } = await api('/meta');
  state.meta = data;
  if (!data.users.some((u) => u.id === state.actor)) state.actor = 'u_omar';
  $('#actor-select').innerHTML = data.users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)} — ${esc(u.role)}</option>`).join('');
  $('#actor-select').value = state.actor;
  $('#filter-store').innerHTML = '<option value="">All accessible stores</option>' + data.stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  if (data.mode === 'live') {
    $('#mode-badge').textContent = 'viaSocket live · demo data still simulated';
    $('#mode-badge').className = 'badge badge-live';
  }
  bind();
  await refresh();
  if (store.get('op.tour', '') === '') showTourOffer();
}

function bind() {
  $('#actor-select').addEventListener('change', async (e) => {
    state.actor = e.target.value;
    store.set('op.actor', state.actor);
    const me = state.meta.users.find((u) => u.id === state.actor);
    toast(`Now acting as ${me.name} (${me.role}) — simulated role`);
    await refresh();
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  $('#filter-store').addEventListener('change', refresh);
  $('#filter-status').addEventListener('change', refresh);
  $('#scrim').addEventListener('click', closePanel);
  $('#reset-all-btn').addEventListener('click', confirmResetAll);
  $('#tour-btn').addEventListener('click', () => startTour(0));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closePanel(); } });
}

function switchView(view) {
  closePanel();
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  refresh();
}

async function refresh() {
  if (state.view === 'issues') await loadIssues();
  if (state.view === 'activity') await loadActivity();
  if (state.view === 'integrations') await loadIntegrations();
  if (state.view === 'team') await loadTeam();
  if (state.openIssue) await loadIssue(state.openIssue);
  schedulePoll();
}

// Poll only while something is in flight (no WebSockets).
function schedulePoll() {
  clearTimeout(state.pollTimer);
  const inFlight = (state.list?.issues || []).some((i) => i.in_flight) ||
    (state.issueData?.operations || []).some((o) => o.state === 'retrying');
  if (inFlight) state.pollTimer = setTimeout(refresh, 1000);
}

// ---------- issues dashboard ----------
async function loadIssues() {
  const qs = new URLSearchParams();
  if ($('#filter-store').value) qs.set('store', $('#filter-store').value);
  if ($('#filter-status').value) qs.set('status', $('#filter-status').value);
  const { data } = await api(`/issues?${qs}`);
  state.list = data;
  const c = data.counts;
  $('#tiles').innerHTML = [
    ['Open issues', c.open], ['Investigate now', c.investigate_now], ['Action required', c.action_required],
    ['Monitor', c.monitor], ['Resolved in this demo', c.resolved_issues], ['Orders tracked', c.orders],
  ].map(([l, n]) => `<div class="tile"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`).join('');
  $('#list-meta').textContent = `${data.issues.length} shown · sorted by priority, then most recent activity`;
  $('#issue-rows').innerHTML = data.issues.map((i) => `
    <tr data-id="${esc(i.id)}" class="${state.openIssue === i.id ? 'selected' : ''}">
      <td><span class="pill p${i.priority.rank}">${esc(i.priority.label)}</span><span class="reason">${esc(i.priority.reason)}</span></td>
      <td>${esc(i.store.name)}</td>
      <td><strong>${esc(i.order_number)}</strong><span class="reason">${esc(i.shopify_order_id)}</span></td>
      <td>${esc(i.workflow)}</td>
      <td><span class="pill shop">${esc(i.shopify_status)}</span></td>
      <td><span class="pill s-${esc(i.status)}">${esc(i.status)}</span></td>
      <td class="muted">${fmt(i.last_activity)}</td>
    </tr>`).join('');
  $('#issues-empty').classList.toggle('hidden', data.issues.length > 0);
  document.querySelectorAll('#issue-rows tr').forEach((tr) => tr.addEventListener('click', () => openIssue(tr.dataset.id)));
}

// ---------- investigation panel ----------
async function openIssue(id) {
  state.openIssue = id;
  $('#panel').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
  await loadIssue(id);
  document.querySelectorAll('#issue-rows tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === id));
  tourEvent('opened-issue', state.issueData);
  schedulePoll();
}

function closePanel() {
  state.openIssue = null;
  state.issueData = null;
  $('#panel').classList.add('hidden');
  $('#scrim').classList.add('hidden');
  document.querySelectorAll('#issue-rows tr').forEach((tr) => tr.classList.remove('selected'));
}

async function loadIssue(id) {
  const { ok, data } = await api(`/issues/${encodeURIComponent(id)}`);
  if (!ok) { closePanel(); return; }
  state.issueData = data;
  renderPanel(data);
}

function renderPanel(i) {
  const ev = i.event;
  const hasRecoverable = i.operations.some((o) => o.required && (o.state === 'failed' || o.state === 'pending'));
  const inFlight = i.operations.some((o) => o.state === 'retrying');
  const sourceBadge = ev.source === 'viasocket' ? '<span class="badge badge-live">viaSocket</span>' : '<span class="badge badge-sim">Simulated</span>';

  $('#panel-body').innerHTML = `
    <div class="panel-head">
      <div>
        <div class="muted">${esc(i.store.name)} · ${esc(i.workflow)} ${sourceBadge}</div>
        <h2>Order ${esc(i.order.order_number)}</h2>
        <div class="muted">Shopify Order ID ${esc(i.order.shopify_order_id)} · Event ${esc(ev.event_id || '(no stable event ID)')}</div>
      </div>
      <button class="btn btn-ghost btn-sm" id="close-panel" aria-label="Close">✕</button>
    </div>

    <div class="states">
      <div class="state-box"><div class="k">Shopify order status</div><span class="pill shop">${esc(i.order.shopify_status)}</span></div>
      <div class="state-box"><div class="k">Overall sync status</div><span class="pill s-${esc(i.status)}">${esc(i.status)}</span></div>
    </div>
    ${i.priority ? `<div class="prio-line"><span class="pill p${i.priority.rank}">${esc(i.priority.label)}</span> <span class="muted">${esc(i.priority.reason)}</span></div>` : ''}
    ${i.order.shopify_status === 'Cancelled' && i.status !== 'Resolved' ? '<div class="notice">The Shopify order <strong>is cancelled</strong>. The sync status only describes downstream destinations; it does not mean the cancellation failed.</div>' : ''}

    <div class="actions">
      ${hasRecoverable && ev.identity === 'confirmed' ? `<button class="btn" id="plan-btn">Prepare recovery plan</button>` : ''}
      ${inFlight ? '<span class="notice">Attempt in flight — new retries are locked until it finishes.</span>' : ''}
      ${ev.identity === 'duplicate' && !ev.acknowledged ? '<button class="btn" id="ack-btn">Acknowledge duplicate</button>' : ''}
      ${ev.event_id && ev.identity === 'confirmed' ? '<button class="btn btn-ghost btn-sm" id="redeliver-btn" title="Demo: send this same event again">Simulate redelivery</button>' : ''}
    </div>
    ${!i.can_execute && hasRecoverable ? `<div class="notice warn">${esc(i.execute_reason)}. You can still investigate and prepare a plan.</div>` : ''}

    ${i.review ? renderReview(i) : ''}
    ${i.duplicate_of ? renderDuplicateOf(i.duplicate_of) : ''}

    ${i.operations.length ? `<h3>Destinations</h3>${i.operations.map(renderOp).join('')}` : ''}

    ${i.related_events.length ? `<h3>Other events for this order</h3><ul class="plan-list">${i.related_events.map((r) => `
      <li><a href="#" data-open="${esc(r.id)}">${esc(r.type)}</a> · ${esc(r.event_id || 'no event ID')} · ${esc(r.identity)}${r.duplicate_of ? ` → ${esc(r.duplicate_of)}` : ''} <span class="muted">${fmt(r.received_at)}</span></li>`).join('')}</ul>` : ''}

    <h3>History</h3>
    <ol class="timeline">${i.history.slice().reverse().map(renderHistory).join('')}</ol>

    <h3>Demo controls</h3>
    <div class="notice">Reset restores only this order's scenario to its baseline. Other issues are untouched.</div>
    <div class="actions"><button class="btn btn-ghost btn-sm" id="reset-one-btn">Reset this scenario</button></div>
  `;

  $('#close-panel').onclick = closePanel;
  $('#reset-one-btn').onclick = async () => {
    await api(`/reset/order/${encodeURIComponent(i.order.id)}`, { method: 'POST' });
    toast(`Order ${i.order.order_number} reset to its baseline scenario`);
    await refresh(); // seeded event IDs are stable, so the panel reopens on the reset issue
  };
  const plan = $('#plan-btn'); if (plan) plan.onclick = () => openPlan(i.id);
  const ack = $('#ack-btn'); if (ack) ack.onclick = async () => { const r = await api(`/events/${encodeURIComponent(i.id)}/acknowledge`, { method: 'POST' }); toast(r.ok ? 'Duplicate acknowledged' : r.data.error); refresh(); };
  const red = $('#redeliver-btn'); if (red) red.onclick = async () => {
    const r = await api(`/events/${encodeURIComponent(i.id)}/redeliver`, { method: 'POST' });
    toast(r.ok ? `Redelivery classified as ${r.data.classification}: linked, nothing repeated` : r.data.error);
    refresh();
  };
  document.querySelectorAll('[data-inspect]').forEach((b) => b.onclick = async () => {
    const r = await api(`/operations/${encodeURIComponent(b.dataset.inspect)}/inspect`, { method: 'POST' });
    toast(r.ok ? r.data.detail : r.data.error);
    refresh();
  });
  document.querySelectorAll('[data-open]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openIssue(a.dataset.open); });
  const rv = $('#review-form'); if (rv) bindReview(i);
}

function renderOp(op) {
  const canInspect = op.state === 'unknown';
  return `<div class="op">
    <div class="op-head">
      <div><div class="op-title">${esc(op.label)}${op.required ? '' : ' <span class="muted">(optional)</span>'}</div>
      <div class="op-meta">${esc(op.target_ref)}</div></div>
      <span class="pill st-${esc(op.state)}">${esc(stateLabel[op.state] || op.state)}</span>
    </div>
    <div class="op-meta">Latest outcome: ${esc(op.last_outcome || '—')} · updated ${fmt(op.updated_at)}</div>
    ${canInspect ? `<div class="actions"><button class="btn btn-sm" data-inspect="${esc(op.id)}">Inspect destination outcome</button><span class="muted" style="font-size:12px">Verify before retrying — it may already have applied.</span></div>` : ''}
    <table class="attempts"><tbody>${op.attempts.map((a) => `
      <tr><td>#${a.n}</td><td>${esc(a.kind)}</td><td><span class="pill st-${esc(a.result || 'retrying')}">${esc(a.result || 'in flight')}</span></td>
      <td>${esc(a.detail || '')}<div class="muted">${esc(userName(a.actor))} · ${esc(a.source)} · ${fmt(a.finished_at || a.started_at)}</div></td></tr>`).join('')}
    </tbody></table>
  </div>`;
}

function renderHistory(h) {
  return `<li class="k-${esc(h.kind)}"><div class="t">${fmt(h.at)} · ${esc(userName(h.actor))} · ${esc(h.kind)}</div>${esc(h.message)}</li>`;
}

function renderDuplicateOf(o) {
  return `<h3>Linked original event</h3><div class="card">
    <div class="kv"><div>Event</div><div><a href="#" data-open="${esc(o.id)}">${esc(o.event_id || o.id)}</a></div>
    <div>Received</div><div>${fmt(o.received_at)}</div><div>Sync status</div><div>${esc(o.status)}</div></div>
    <ul class="plan-list">${o.operations.map((p) => `<li>${esc(p.label)}: <span class="pill st-${esc(p.state)}">${esc(stateLabel[p.state])}</span></li>`).join('')}</ul>
    <div class="notice">No order record was created and no notification was repeated for this delivery.</div></div>`;
}

function renderReview(i) {
  const r = i.review;
  const pending = i.event.identity === 'uncertain';
  return `<h3>Identity review</h3><div class="card">
    ${pending ? '<div class="notice warn"><strong>Identity uncertain.</strong> This delivery has no stable event ID. Side effects are held until it is reviewed. A matching order ID does not prove a duplicate.</div>' : ''}
    <div class="kv" style="margin-top:10px">
      <div>Incoming event ID</div><div>${esc(r.incoming.event_id)}</div>
      <div>Type</div><div>${esc(r.incoming.type)}</div>
      <div>Shopify Order ID</div><div>${esc(r.incoming.shopify_order_id)}</div>
      <div>Received</div><div>${fmt(r.incoming.received_at)}</div>
    </div>
    ${r.closest_match ? `<h3>Closest existing event</h3><div class="kv">
      <div>Event</div><div><a href="#" data-open="${esc(r.closest_match.id)}">${esc(r.closest_match.event_id)}</a></div>
      <div>Received</div><div>${fmt(r.closest_match.received_at)}</div>
      <div>Sync status</div><div>${esc(r.closest_match.status)}</div></div>
      <ul class="plan-list">${r.closest_match.operations.map((p) => `<li>${esc(p.label)}: <span class="pill st-${esc(p.state)}">${esc(stateLabel[p.state])}</span> <span class="muted">${esc(p.last_outcome)}</span></li>`).join('')}</ul>` : '<p class="muted">No matching existing event found.</p>'}
    ${r.side_effects_may_have_occurred ? '<div class="notice bad">Side effects may already have occurred for the matching event. Processing this as new could duplicate them.</div>' : ''}
    ${r.decision ? `<div class="notice">Decision: <strong>${esc(r.decision)}</strong> by ${esc(userName(r.reviewed_by))} · ${fmt(r.reviewed_at)}<br>Rationale: ${esc(r.rationale || '—')}</div>` : ''}
    ${pending ? `<form id="review-form" style="margin-top:12px">
      <label class="muted" for="rv-why">Rationale (recorded in history)</label>
      <textarea id="rv-why" placeholder="e.g. Same order and payload timestamps as the processed event; Shopify retry."></textarea>
      <div class="actions">
        <button class="btn" type="button" data-decision="duplicate" ${r.closest_match ? '' : 'disabled'}>Classify as duplicate</button>
        <button class="btn btn-ghost" type="button" data-decision="new">Classify as new…</button>
        <button class="btn btn-ghost" type="button" data-decision="uncertain">Leave uncertain</button>
      </div></form>` : ''}
  </div>`;
}

function bindReview(i) {
  document.querySelectorAll('#review-form [data-decision]').forEach((b) => b.onclick = async () => {
    const decision = b.dataset.decision;
    const rationale = $('#rv-why').value;
    if (decision === 'new' && !confirm('Classifying as new creates pending destination operations. Nothing runs until an authorized operator approves the plan. Continue?')) return;
    const r = await api(`/events/${encodeURIComponent(i.id)}/review`, { method: 'POST', body: { decision, rationale } });
    if (!r.ok) return toast(r.data.error);
    toast(decision === 'duplicate' ? 'Linked to existing history — nothing repeated' : decision === 'new' ? 'Classified as new — review the plan next' : 'Left uncertain');
    await refresh();
    if (decision === 'new') openPlan(i.id);
  });
}

// ---------- approval & execution ----------
async function openPlan(eventRef) {
  const { ok, data } = await api(`/issues/${encodeURIComponent(eventRef)}/plan`, { method: 'POST' });
  if (!ok) return toast(data.error);
  renderPlanModal(data.plan, data.can_execute, data.execute_reason);
}

function renderPlanModal(plan, canExec, reason, notice) {
  const ttl = Math.round((state.meta.approval_ttl_ms || 120000) / 1000);
  $('#modal-card').innerHTML = `
    <h2>Recovery plan · ${esc(plan.store_name)} ${esc(plan.order_number)}</h2>
    ${notice ? `<div class="notice warn">${esc(notice)}</div>` : ''}
    <div class="muted">${esc(plan.workflow)} · plan ${esc(plan.plan_hash)}</div>
    ${plan.steps.length ? `<h3>Will run</h3><ul class="plan-list">${plan.steps.map((s) => `
      <li><strong>${esc(s.intent === 'retry' ? 'Retry' : 'Process')} ${esc(s.label)}</strong> → ${esc(s.target_ref)}<br><span class="muted">Attempt #${s.next_attempt} · ${esc(s.reason)}</span></li>`).join('')}</ul>` : ''}
    ${plan.preserved.length ? `<h3>Preserved</h3><ul class="plan-list">${plan.preserved.map((s) => `<li>${esc(s.label)} — <span class="muted">${esc(s.note)}</span></li>`).join('')}</ul>` : ''}
    ${plan.verify_first.length ? `<h3>Verify first</h3><ul class="plan-list">${plan.verify_first.map((s) => `<li>${esc(s.label)} — <span class="muted">${esc(s.note)}</span></li>`).join('')}</ul>` : ''}
    ${plan.blocked_reason ? `<div class="notice warn">${esc(plan.blocked_reason)}</div>` : ''}
    <div class="notice">Approving authorizes exactly this plan, once. It does not guarantee success. Fresh approval is required immediately before every execution, including retries (approval valid for ${ttl}s). This is a simulation unless the event came from viaSocket.</div>
    ${!canExec ? `<div class="notice bad">${esc(reason)}</div>` : ''}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="m-cancel">Cancel</button>
      <button class="btn" id="m-approve" ${canExec && plan.executable ? '' : 'disabled'}>Approve &amp; execute now</button>
    </div>`;
  openModal();
  $('#m-cancel').onclick = () => { closeModal(); toast('Cancelled — nothing was executed'); };
  const btn = $('#m-approve');
  btn.onclick = async () => {
    btn.disabled = true;
    const a = await api('/approvals', { method: 'POST', body: { event_ref: plan.event_ref, plan_hash: plan.plan_hash } });
    if (!a.ok) return handlePlanError(a, plan);
    const x = await api('/executions', { method: 'POST', body: { approval_id: a.data.approval.id } });
    if (!x.ok) return handlePlanError(x, plan);
    closeModal();
    toast(`Executing ${x.data.started.length} operation(s) — awaiting confirmed outcome`);
    tourEvent('executed');
    await refresh();
  };
}

function handlePlanError(r, plan) {
  if (r.data.plan_changed && r.data.plan) {
    return renderPlanModal(r.data.plan, true, null, 'The plan changed. Review the current plan below and approve again.');
  }
  closeModal();
  toast(r.data.error || 'Request failed');
  refresh();
}

function openModal() { $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }

function confirmResetAll() {
  $('#modal-card').innerHTML = `
    <h2>Reset the whole workspace?</h2>
    <div class="notice bad">All demo progress and history will be lost. Every synthetic store, order, issue, user permission and approval returns to the original baseline.</div>
    <p class="muted">This is demo management only. It does not recover or change anything in a live system.</p>
    <div class="modal-actions"><button class="btn btn-ghost" id="m-cancel">Cancel</button><button class="btn btn-danger" id="m-reset">Reset workspace</button></div>`;
  openModal();
  $('#m-cancel').onclick = closeModal;
  $('#m-reset').onclick = async () => {
    await api('/reset/all', { method: 'POST', body: { confirm: 'RESET' } });
    closeModal(); closePanel();
    state.meta = (await api('/meta')).data;
    toast('Workspace reset to baseline');
    refresh();
  };
}

// ---------- activity ----------
async function loadActivity() {
  const [list, act] = await Promise.all([api('/issues'), api('/activity')]);
  const resolved = list.data.resolved;
  $('#resolved-rows').innerHTML = resolved.map((i) => `
    <tr data-id="${esc(i.id)}"><td>${esc(i.store.name)}</td><td><strong>${esc(i.order_number)}</strong></td><td>${esc(i.workflow)}</td>
    <td><span class="pill shop">${esc(i.shopify_status)}</span></td><td><span class="pill s-${esc(i.status)}">${esc(i.status)}</span></td><td class="muted">${fmt(i.last_activity)}</td></tr>`).join('');
  $('#resolved-empty').classList.toggle('hidden', resolved.length > 0);
  document.querySelectorAll('#resolved-rows tr').forEach((tr) => tr.addEventListener('click', () => openIssue(tr.dataset.id)));
  $('#activity-list').innerHTML = act.data.activity.map((h) => `<li class="k-${esc(h.kind)}"><div class="t">${fmt(h.at)} · ${esc(userName(h.actor))} · ${esc(h.kind)}${h.order_number ? ` · ${esc(h.order_number)}` : ''}</div>${esc(h.message)}</li>`).join('');
}

// ---------- team / permissions ----------
async function loadTeam() {
  const { data } = await api('/team');
  const me = state.meta.users.find((u) => u.id === state.actor);
  const isAdmin = me && me.role === 'admin';
  const stores = state.meta.stores;
  $('#team').innerHTML = `
    <div class="card"><strong>Store-scoped execution permission</strong>
      <p class="muted">Anyone can investigate. Only operators/admins with permission for a specific store can approve and execute recovery there. Only agency administrators can grant or revoke. Permission is re-checked immediately before every execution; revoking keeps all history. Roles here are simulated, not production security.</p>
      ${isAdmin ? '' : '<div class="notice warn">Switch to the admin user to change permissions.</div>'}
    </div>
    <div class="table-wrap"><table class="issues perm-grid"><thead><tr><th>Team member</th><th>Role</th>${stores.map((s) => `<th>${esc(s.name)}</th>`).join('')}</tr></thead>
    <tbody>${data.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.role)}</td>${stores.map((s) => {
      const has = u.stores.includes(s.id);
      if (u.role === 'investigator') return '<td class="muted">investigate only</td>';
      return `<td><label><input type="checkbox" data-user="${esc(u.id)}" data-store="${esc(s.id)}" ${has ? 'checked' : ''} ${isAdmin ? '' : 'disabled'}> ${has ? 'can execute' : 'no'}</label></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
  document.querySelectorAll('#team input[type=checkbox]').forEach((cb) => cb.onchange = async () => {
    const r = await api('/permissions', { method: 'POST', body: { user_id: cb.dataset.user, store_id: cb.dataset.store, grant: cb.checked } });
    toast(r.ok ? 'Permission updated and logged' : r.data.error);
    state.meta = (await api('/meta')).data;
    loadTeam();
  });
}

// ---------- integrations (viaSocket Embed) ----------
async function loadIntegrations() {
  const { data } = await api('/integrations');
  const live = data.mode === 'live' && data.embed_configured;
  $('#integrations').innerHTML = `
    <div class="card">
      <strong>viaSocket powers the live workflow; OrderPilot gives the agency visibility and safe recovery.</strong>
      <div class="flow"><span class="node">Shopify order created / cancelled</span>→<span class="node">viaSocket flow (per client store)</span>→<span class="node">Airtable upsert by Shopify Order ID</span>+<span class="node">Slack cancellation notice</span>→<span class="node">Report to OrderPilot</span></div>
      <div class="kv" style="margin-top:10px">
        <div>Mode</div><div>${live ? '<span class="badge badge-live">Live</span>' : '<span class="badge badge-sim">Simulated</span>'} ${esc(data.mode)}</div>
        <div>Embed configured</div><div>${data.embed_configured ? 'Yes' : 'No — set VIASOCKET_ORG_ID, VIASOCKET_PROJECT_ID, VIASOCKET_ACCESS_KEY'}</div>
        <div>Report webhook</div><div><code>${esc(data.webhook_url)}</code> ${data.webhook_signed ? '(HMAC signed)' : '<span class="muted">(unsigned — set VIASOCKET_WEBHOOK_SECRET)</span>'}</div>
        <div>Retry flows</div><div>Airtable: ${data.retry_flows.airtable ? 'configured' : 'not set'} · Slack: ${data.retry_flows.slack ? 'configured' : 'not set'}</div>
      </div>
      ${live ? '' : '<div class="notice warn">viaSocket is not connected. The demo runs entirely on simulated destinations. See the README for the live setup.</div>'}
    </div>
    ${data.stores.map((s) => `<div class="card">
      <div class="op-head"><div><strong>${esc(s.name)}</strong><div class="op-meta">viaSocket user: <code>${esc(s.viasocket_user_id)}</code> — connections and flows are isolated per store</div></div>
      <button class="btn btn-sm" data-embed="${esc(s.id)}" ${live ? '' : 'disabled'}>Manage integrations</button></div>
      <div class="embed-host hidden" id="embed-${esc(s.id)}"></div>
    </div>`).join('')}`;
  document.querySelectorAll('[data-embed]').forEach((b) => b.onclick = () => mountEmbed(b.dataset.embed));
}

// Loads the viaSocket Embed script for one store with a server-minted token.
async function mountEmbed(storeId) {
  const r = await api(`/integrations/${encodeURIComponent(storeId)}/embed-token`);
  if (!r.ok) return toast(r.data.error);
  const host = document.getElementById(`embed-${storeId}`);
  document.querySelectorAll('.embed-host').forEach((h) => { h.classList.add('hidden'); h.innerHTML = ''; });
  document.getElementById('viasocket-embed-main-script')?.remove();
  host.classList.remove('hidden');
  host.innerHTML = '<div class="muted">Loading viaSocket…</div>';
  const s = document.createElement('script');
  s.id = 'viasocket-embed-main-script';
  s.src = r.data.script_url;
  s.setAttribute('embedToken', r.data.token);
  s.setAttribute('parentId', host.id);
  s.onload = () => { host.querySelector('.muted')?.remove(); if (typeof window.openViasocket === 'function') window.openViasocket(); };
  s.onerror = () => { host.innerHTML = '<div class="notice bad">Could not load the viaSocket Embed script. Check VIASOCKET_EMBED_SCRIPT_URL.</div>'; };
  document.body.appendChild(s);
}

// ---------- guided tour (optional, skippable) ----------
const TOUR = [
  { title: 'Open a failed Airtable sync', body: 'Click Northstar Goods order #1004 ("Airtable order upsert failed"). Everything here is a simulation with synthetic data.' },
  { title: 'Inspect its history', body: 'Note the Shopify order status is separate from the sync status. Scroll to Destinations and History to see the failed attempt.' },
  { title: 'Simulate retries: Fail → Fail → Succeed', body: 'Click "Prepare recovery plan", then "Approve & execute now". It fails once more (simulated). Approve again — every retry needs fresh approval — and it succeeds.' },
  { title: 'Confirm simulated resolution', body: 'The issue becomes Resolved only once the Airtable upsert is confirmed. It leaves the queue and stays in Activity. Use "Reset this scenario" to replay.' },
];
let tourStep = -1;

function showTourOffer() {
  $('#tour').innerHTML = `<div class="step">Optional</div><strong>Take a 4-step guided tour?</strong>
    <p class="muted">You'll recover a failed Airtable sync yourself. All actions and results are simulated.</p>
    <div class="modal-actions"><button class="btn btn-ghost btn-sm" id="t-skip">Skip</button><button class="btn btn-sm" id="t-go">Start tour</button></div>`;
  $('#tour').classList.remove('hidden');
  $('#t-skip').onclick = () => { store.set('op.tour', 'skipped'); $('#tour').classList.add('hidden'); };
  $('#t-go').onclick = () => startTour(0);
}

function startTour(n) {
  tourStep = n;
  store.set('op.tour', 'seen');
  if (n >= TOUR.length) { $('#tour').classList.add('hidden'); tourStep = -1; return; }
  const s = TOUR[n];
  $('#tour').innerHTML = `<div class="step">Simulation tour · step ${n + 1} of ${TOUR.length}</div><strong>${esc(s.title)}</strong><p class="muted">${esc(s.body)}</p>
    <div class="modal-actions"><button class="btn btn-ghost btn-sm" id="t-skip">End tour</button><button class="btn btn-sm" id="t-next">${n === TOUR.length - 1 ? 'Done' : 'Next'}</button></div>`;
  $('#tour').classList.remove('hidden');
  $('#t-skip').onclick = () => startTour(TOUR.length);
  $('#t-next').onclick = () => startTour(n + 1);
}

// Advance the tour when the user performs the step themselves (never automatically resolves anything).
function tourEvent(kind, data) {
  if (tourStep === 0 && kind === 'opened-issue' && data?.order?.order_number === '#1004') startTour(1);
  else if (tourStep === 1 && kind === 'executed') startTour(2);
}

boot();
