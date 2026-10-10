'use strict';

// Client stores. Demo stores come from the seed and are reset with the
// workspace; live stores are added by an agency administrator and are never
// touched by a demo reset.

const { get } = require('./db');

const SHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const AIRTABLE_BASE = /^app[A-Za-z0-9]{14}$/;
const SLACK_CHANNEL = /^#[a-z0-9][a-z0-9._-]{0,79}$/;

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'store';
}

function validate(body) {
  const input = {
    name: clean(body.name),
    slack_channel: clean(body.slack_channel).toLowerCase(),
    shopify_domain: clean(body.shopify_domain).toLowerCase() || null,
    airtable_base: clean(body.airtable_base) || null,
    airtable_table: clean(body.airtable_table) || null,
  };
  if (!input.name || input.name.length > 80) return { error: 'name is required (max 80 characters)' };
  if (!SLACK_CHANNEL.test(input.slack_channel)) return { error: 'slack_channel must look like #store-orders' };
  if (input.shopify_domain && !SHOPIFY_DOMAIN.test(input.shopify_domain)) return { error: 'shopify_domain must look like your-store.myshopify.com' };
  if (input.airtable_base && !AIRTABLE_BASE.test(input.airtable_base)) return { error: 'airtable_base must be an Airtable base ID (app followed by 14 characters)' };
  if (input.airtable_table && input.airtable_table.length > 100) return { error: 'airtable_table is too long (max 100 characters)' };
  return { input };
}

// The creating admin gets execution permission on the new store so they can
// open its viaSocket embed straight away. Both steps are logged.
function createStore(admin, body) {
  if (!admin || admin.role !== 'admin') return { status: 403, error: 'Only agency administrators can add client stores' };
  const { input, error } = validate(body || {});
  if (error) return { status: 400, error };
  const d = get();
  if (input.shopify_domain && d.prepare('SELECT 1 FROM stores WHERE shopify_domain = ?').get(input.shopify_domain)) {
    return { status: 409, error: `A store for ${input.shopify_domain} already exists` };
  }
  const base = `s_${slug(input.name)}`;
  let id = base;
  for (let n = 2; d.prepare('SELECT 1 FROM stores WHERE id = ?').get(id); n++) id = `${base}_${n}`;
  const now = new Date().toISOString();
  d.transaction(() => {
    d.prepare(`INSERT INTO stores (id, name, slack_channel, kind, shopify_domain, airtable_base, airtable_table, created_at, created_by)
      VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?)`).run(id, input.name, input.slack_channel, input.shopify_domain, input.airtable_base, input.airtable_table, now, admin.id);
    d.prepare('INSERT INTO permissions (user_id, store_id, granted_by, granted_at) VALUES (?, ?, ?, ?)').run(admin.id, id, admin.id, now);
    const log = d.prepare(`INSERT INTO history (event_ref, at, actor, kind, message, store_id) VALUES (NULL, ?, ?, ?, ?, ?)`);
    log.run(now, admin.id, 'store', `${admin.name} added live client store ${input.name}`, id);
    log.run(now, admin.id, 'permission', `${admin.name} granted execution permission for ${admin.name} on ${input.name}`, id);
  })();
  return { status: 201, store: d.prepare('SELECT * FROM stores WHERE id = ?').get(id) };
}

function hasLiveStores() {
  return !!get().prepare("SELECT 1 FROM stores WHERE kind = 'live' LIMIT 1").get();
}

module.exports = { createStore, hasLiveStores, validate };
