'use strict';

// Simulated roles and store-scoped execution permissions (spec §7).
// NOT production security: the acting user comes from a request header chosen
// in the UI. Real authentication and server-side authorization are required
// before customer use.

const { get } = require('./db');

const DEFAULT_ACTOR = 'u_omar';

function getUser(id) {
  return get().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function actorFrom(req) {
  return getUser(req.get('x-actor') || DEFAULT_ACTOR);
}

function activePermission(userId, storeId) {
  return get()
    .prepare('SELECT * FROM permissions WHERE user_id = ? AND store_id = ? AND revoked_at IS NULL')
    .get(userId, storeId) || null;
}

// Investigators never execute. Operators and admins need an explicit, active
// permission for the specific store.
function canExecute(user, storeId) {
  if (!user) return { ok: false, reason: 'Unknown user' };
  if (user.role === 'investigator') return { ok: false, reason: 'Investigators can inspect and prepare plans but cannot approve or execute' };
  if (!activePermission(user.id, storeId)) return { ok: false, reason: `${user.name} has no execution permission for this store` };
  return { ok: true };
}

function listUsersWithPermissions() {
  const d = get();
  const users = d.prepare('SELECT * FROM users ORDER BY id').all();
  const perms = d.prepare('SELECT * FROM permissions WHERE revoked_at IS NULL').all();
  return users.map((u) => ({ ...u, stores: perms.filter((p) => p.user_id === u.id).map((p) => p.store_id) }));
}

function setPermission(admin, userId, storeId, grant) {
  const d = get();
  if (!admin || admin.role !== 'admin') return { status: 403, error: 'Only agency administrators can grant or revoke execution permission' };
  const user = getUser(userId);
  const store = d.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  if (!user || !store) return { status: 404, error: 'Unknown user or store' };
  const now = new Date().toISOString();
  const existing = activePermission(userId, storeId);
  if (grant && !existing) {
    d.prepare('INSERT INTO permissions (user_id, store_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(userId, storeId, admin.id, now);
  } else if (!grant && existing) {
    // Revocation blocks future approvals/executions only. History, prior
    // approvals and completed outcomes remain intact.
    d.prepare('UPDATE permissions SET revoked_by = ?, revoked_at = ? WHERE id = ?').run(admin.id, now, existing.id);
  } else {
    return { status: 200, changed: false };
  }
  d.prepare(`INSERT INTO history (event_ref, at, actor, kind, message) VALUES (NULL, ?, ?, 'permission', ?)`).run(
    now, admin.id,
    `${admin.name} ${grant ? 'granted' : 'revoked'} execution permission for ${user.name} on ${store.name}`,
  );
  return { status: 200, changed: true };
}

module.exports = { DEFAULT_ACTOR, getUser, actorFrom, canExecute, listUsersWithPermissions, setPermission };
