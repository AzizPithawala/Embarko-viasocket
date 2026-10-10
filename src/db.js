'use strict';

// SQLite under DATA_DIR (spec §2). Disposable demo storage: no durability,
// backup or restore guarantees.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const seed = require('./seed');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slack_channel TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'demo',   -- demo (seeded, resettable) | live (real client store)
  shopify_domain TEXT, airtable_base TEXT, airtable_table TEXT,
  created_at TEXT, created_by TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, store_id TEXT NOT NULL,
  granted_by TEXT NOT NULL, granted_at TEXT NOT NULL,
  revoked_by TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL, shopify_order_id TEXT NOT NULL,
  order_number TEXT NOT NULL, shopify_status TEXT NOT NULL, total REAL NOT NULL,
  customer_alias TEXT NOT NULL, created_at TEXT NOT NULL, scenario TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL, event_id TEXT, order_id TEXT NOT NULL,
  type TEXT NOT NULL, received_at TEXT NOT NULL,
  identity TEXT NOT NULL,            -- confirmed | duplicate | uncertain
  duplicate_of TEXT, closest_match TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  review_decision TEXT, review_rationale TEXT, reviewed_by TEXT, reviewed_at TEXT,
  reported_json TEXT,                -- what an uncertain delivery reported (evidence only)
  source TEXT NOT NULL DEFAULT 'simulated'
);
CREATE INDEX IF NOT EXISTS events_identity ON events(store_id, event_id);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, event_ref TEXT NOT NULL,
  destination TEXT NOT NULL, kind TEXT NOT NULL, target_ref TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,               -- pending | success | failed | unknown | retrying
  last_outcome TEXT, updated_at TEXT NOT NULL,
  script TEXT NOT NULL DEFAULT '[]', script_pos INTEGER NOT NULL DEFAULT 0,
  inspect_result TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL, n INTEGER NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  result TEXT,                        -- null while in flight
  detail TEXT, approval_id TEXT, actor TEXT NOT NULL,
  source TEXT NOT NULL, kind TEXT NOT NULL, attempt_key TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, event_ref TEXT NOT NULL,
  plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_ref TEXT, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
  store_id TEXT                       -- set on store-level entries (permissions, store setup)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

let db = null;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves
// older databases untouched, so add whatever is missing.
const ADDED_COLUMNS = {
  stores: ["kind TEXT NOT NULL DEFAULT 'demo'", 'shopify_domain TEXT', 'airtable_base TEXT', 'airtable_table TEXT', 'created_at TEXT', 'created_by TEXT'],
  history: ['store_id TEXT'],
};

function migrate(d) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const col of cols) if (!have.has(col.split(' ')[0])) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
  }
}

function open() {
  if (db) return db;
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const file = process.env.DB_FILE || path.join(dataDir, 'orderpilot.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  const seeded = db.prepare("SELECT value FROM meta WHERE key = 'seeded'").get();
  if (!seeded) resetAll();
  return db;
}

function get() {
  return db || open();
}

function insertRows(d, rows) {
  const ins = {
    orders: d.prepare(`INSERT INTO orders (id, store_id, shopify_order_id, order_number, shopify_status, total, customer_alias, created_at, scenario)
      VALUES (@id, @store_id, @shopify_order_id, @order_number, @shopify_status, @total, @customer_alias, @created_at, @scenario)`),
    events: d.prepare(`INSERT INTO events (id, store_id, event_id, order_id, type, received_at, identity, duplicate_of, closest_match, acknowledged, source)
      VALUES (@id, @store_id, @event_id, @order_id, @type, @received_at, @identity, @duplicate_of, @closest_match, @acknowledged, @source)`),
    operations: d.prepare(`INSERT INTO operations (id, event_ref, destination, kind, target_ref, required, state, last_outcome, updated_at, script, script_pos, inspect_result)
      VALUES (@id, @event_ref, @destination, @kind, @target_ref, @required, @state, @last_outcome, @updated_at, @script, @script_pos, @inspect_result)`),
    attempts: d.prepare(`INSERT INTO attempts (operation_id, n, started_at, finished_at, result, detail, approval_id, actor, source, kind)
      VALUES (@operation_id, @n, @started_at, @finished_at, @result, @detail, @approval_id, @actor, @source, @kind)`),
    history: d.prepare(`INSERT INTO history (event_ref, at, actor, kind, message) VALUES (@event_ref, @at, @actor, @kind, @message)`),
  };
  for (const table of ['orders', 'events', 'operations', 'attempts', 'history']) {
    for (const row of rows[table]) ins[table].run(row);
  }
}

// Full workspace reset: restore every synthetic store/order/issue to baseline.
// Live client stores, their orders, permissions and history are never touched.
function resetAll() {
  const d = db || open();
  d.transaction(() => {
    const demo = "SELECT id FROM stores WHERE kind = 'demo'";
    const demoEvents = `SELECT id FROM events WHERE store_id IN (${demo})`;
    d.prepare(`DELETE FROM attempts WHERE operation_id IN (SELECT id FROM operations WHERE event_ref IN (${demoEvents}))`).run();
    d.prepare(`DELETE FROM operations WHERE event_ref IN (${demoEvents})`).run();
    d.prepare(`DELETE FROM approvals WHERE event_ref IN (${demoEvents})`).run();
    d.prepare(`DELETE FROM history WHERE event_ref IN (${demoEvents}) OR store_id IN (${demo}) OR (event_ref IS NULL AND store_id IS NULL)`).run();
    d.prepare(`DELETE FROM events WHERE store_id IN (${demo})`).run();
    d.prepare(`DELETE FROM orders WHERE store_id IN (${demo})`).run();
    d.prepare(`DELETE FROM permissions WHERE store_id IN (${demo})`).run();
    d.prepare("DELETE FROM stores WHERE kind = 'demo'").run();
    if (!d.prepare('SELECT 1 FROM stores LIMIT 1').get()) {
      d.prepare("DELETE FROM sqlite_sequence WHERE name IN ('permissions','attempts','history')").run();
    }
    const insStore = d.prepare("INSERT INTO stores (id, name, slack_channel, kind) VALUES (@id, @name, @slack_channel, 'demo')");
    seed.STORES.forEach((s) => insStore.run(s));
    const insUser = d.prepare('INSERT OR REPLACE INTO users (id, name, role) VALUES (@id, @name, @role)');
    seed.USERS.forEach((u) => insUser.run(u));
    const insPerm = d.prepare(`INSERT INTO permissions (user_id, store_id, granted_by, granted_at) VALUES (?, ?, 'u_ada', ?)`);
    seed.PERMISSIONS.forEach((p) => insPerm.run(p.user_id, p.store_id, new Date(seed.T0 - 86_400_000).toISOString()));
    insertRows(d, seed.buildBaseline());
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', ?)").run(new Date().toISOString());
  })();
}

// Per-issue reset: rebuild only the rows belonging to one order from baseline.
// Other issues, users and permissions are untouched.
function resetOrder(orderId, actor) {
  const d = get();
  const baseline = seed.buildOrderBaseline(orderId);
  if (!baseline) return false;
  d.transaction(() => {
    const eventIds = d.prepare('SELECT id FROM events WHERE order_id = ?').all(orderId).map((r) => r.id);
    for (const id of eventIds) {
      d.prepare('DELETE FROM attempts WHERE operation_id IN (SELECT id FROM operations WHERE event_ref = ?)').run(id);
      d.prepare('DELETE FROM operations WHERE event_ref = ?').run(id);
      d.prepare('DELETE FROM approvals WHERE event_ref = ?').run(id);
      d.prepare('DELETE FROM history WHERE event_ref = ?').run(id);
    }
    d.prepare('DELETE FROM events WHERE order_id = ?').run(orderId);
    d.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    insertRows(d, baseline);
    d.prepare(`INSERT INTO history (event_ref, at, actor, kind, message) VALUES (NULL, ?, ?, 'reset', ?)`).run(
      new Date().toISOString(), actor || 'system', `Demo reset: order ${baseline.orders[0].order_number} restored to its baseline scenario`,
    );
  })();
  return true;
}

function close() {
  if (db) db.close();
  db = null;
}

module.exports = { open, get, resetAll, resetOrder, close };
