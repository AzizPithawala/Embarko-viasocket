# OrderPilot × viaSocket — Execution Plan v2

## Context
OrderPilot is built and pushed: PR [AzizPithawala/Embarko-viasocket#1](https://github.com/AzizPithawala/Embarko-viasocket/pull/1), branch `claude/charming-turing-5jmd3s`, 33 tests passing.

It already has the viaSocket wiring:
- per-store Embed JWT (`src/viasocket/embedToken.js`);
- the Integrations tab and `mountEmbed()` (`public/app.js`);
- a signed result webhook (`POST /api/webhooks/viasocket` in `src/routes/api.js`, handled by `src/engine/ingest.js`);
- a live single-op retry adapter (`src/adapters/viasocket.js`).

All of this is off until credentials exist.

The user wants, in this order:
1. Embed viaSocket for real: how to get the keys, where they go, and which code gaps block a live connection.
2. Test end-to-end with real accounts.
3. Improve the current project.
4. Further agency use cases solved through viaSocket. They must be real, specific problems, not generic ideas.

Each phase below has exit criteria. Phase N+1 starts only when phase N passes.

---

## Phase 1 — Embed viaSocket for real

### 1.1 Get the embed credentials (you do this in viaSocket)
1. Sign in at viasocket.com with the agency's workspace. The org that owns the embed is the one billed and visible in its dashboard.
2. Open **Embed** (viaSocket Embed / "Embed viaSocket into your SaaS") and **create an embed configuration/project** for OrderPilot.
3. Copy the four values viaSocket gives you:

   | viaSocket value | OrderPilot env var | Secret? |
   |---|---|---|
   | Org ID | `VIASOCKET_ORG_ID` | no |
   | Project ID | `VIASOCKET_PROJECT_ID` | no |
   | Access key (signs the HS256 JWT) | `VIASOCKET_ACCESS_KEY` | **yes, server only** |
   | Embed SDK script URL (from the copy-paste snippet) | `VIASOCKET_EMBED_SCRIPT_URL` | no |

   `user_id` is not something you copy. OrderPilot generates it per client store as `store_<storeId>`, which isolates each store's connections and flows.
4. Copy the **whole SDK snippet** viaSocket shows (script tag, attribute names, any `openViasocket()` call) and paste it to me. Public docs confirm the JWT fields (org_id, project_id, user_id, HS256 signed with the access key), that embedding is iframe-only via their script, and that `openViasocket(flowId)` opens a flow. They do **not** confirm the exact script tag id and attribute names, so we match the snippet exactly.
5. Make up two more secrets for OrderPilot itself:
   - `VIASOCKET_WEBHOOK_SECRET`: any 32+ char random string, for example from `openssl rand -hex 32`.
   - `ADMIN_BOOTSTRAP_TOKEN`: new in 1.3e.

### 1.2 Where to put them
- **Embarko (deployed):** the environment's secrets/env settings. Required: `VIASOCKET_ACCESS_KEY`, `VIASOCKET_WEBHOOK_SECRET`. Also set the plain vars `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID`, `VIASOCKET_EMBED_SCRIPT_URL`, `PUBLIC_URL=https://<embarko-app-url>`, `DATA_DIR=<persistent path>`, and `VIASOCKET_MODE=live`. Retry URLs are set later, in 1.4.
- **Local:** copy `.env.example` to `.env` (already gitignored) and fill it in. *Code gap:* the app does not read `.env` today. Fix it in `src/config.js` by calling `process.loadEnvFile()` when `.env` exists (built into Node ≥20.12, no dependency).
- **Never** in git, the PR, the frontend or chat logs. The browser only ever receives the signed per-store token from `GET /api/integrations/:storeId/embed-token`.

### 1.3 Code changes needed before a live connection works
| # | Gap today | Change | Files |
|---|---|---|---|
| a | `.env` not loaded | `process.loadEnvFile()` guarded by `fs.existsSync` | `src/config.js` |
| b | Script tag guessed (`viasocket-embed-main-script`, `embedToken`, `parentId`) | Match the dashboard snippet exactly. Keep the URL in env. Call `openViasocket()` only if the snippet uses it | `public/app.js` `mountEmbed()` |
| c | Embed only works when `VIASOCKET_MODE=live` | Decouple: embed is available whenever the 3 credentials exist. `live` only controls how webhook events are tagged and routed | `src/routes/api.js`, `src/config.js` |
| d | JWT has only org/project/user | Add optional `name` = store name (supported per viaSocket FAQ) so the viaSocket UI shows which client store you're in. Add `exp` (e.g. 1h) if the snippet/docs accept it | `src/viasocket/embedToken.js` |
| e | **Client stores exist only in the seed** — you cannot add a real store | Admin "Add client store" form plus `POST /api/stores` (name, Shopify domain, Slack channel, Airtable base/table). Real stores are flagged `live`; demo stores stay `simulated`. The first admin is created with `ADMIN_BOOTSTRAP_TOKEN` | `src/db.js` (schema), `src/routes/api.js`, `public/app.js` (Team/Integrations tab) |
| f | HMAC signing may be impossible inside a viaSocket HTTP step | Accept either `X-OrderPilot-Signature` (HMAC, used when a viaSocket JS/code step can compute it) **or** `Authorization: Bearer <VIASOCKET_WEBHOOK_SECRET>` | `src/routes/api.js` webhook handler |
| g | Flows need to know `store_id` and the callback URL | Pass `store_id` and `orderpilot_webhook_url` as **Embed custom parameters** (viaSocket "Custom parameters in Embed SDK"). Flow templates reference them, so one template works for every store | `public/app.js`, `src/routes/api.js` |
| h | Live-mode demo data mixed with real data | Dashboard toggle: Live stores / Demo stores / All. Defaults to Live once at least one live store exists | `src/issues.js` `listIssues`, `public/app.js` |

### 1.4 Build the flow templates in the viaSocket embed project
Build these once, as templates every store user can enable:
1. **Order created:**
   1. Shopify trigger `orders/create`.
   2. Airtable *Create or update* keyed by `Shopify Order ID`.
   3. HTTP POST to `{{orderpilot_webhook_url}}` with `{store_id, event_id, shopify_order_id, order_number, event_type:"created", operations:[{destination:"airtable", result, detail, execution_id}]}`. Use the step's success/failure branch to set `result`.
2. **Order cancelled:**
   1. Shopify trigger `orders/cancelled`.
   2. Airtable update `Status=Cancelled`.
   3. Slack message to the store's channel.
   4. HTTP POST reporting both operations.
3. **Retry Airtable** and **Retry Slack:** webhook trigger, then the single action, then an HTTP POST `{attempt_key, result, detail, execution_id}`. Paste each trigger URL into `VIASOCKET_RETRY_AIRTABLE_URL` / `VIASOCKET_RETRY_SLACK_URL`.

**Event ID:** map Shopify's `X-Shopify-Event-Id` (or `X-Shopify-Webhook-Id`) header if viaSocket's Shopify trigger exposes it.
- If it doesn't, every event arrives as *uncertain*, which is correct but noisy.
- The fallback is a deterministic ID: `topic + order_id + updated_at`. It is computed in the flow and labelled as derived in OrderPilot's history.

**Exit criteria:**
- Embed iframe opens for a live store.
- The store's connections appear under `store_<id>` only.
- A signed test POST creates an issue.

---

## Phase 2 — Test

### 2.1 Test accounts (free)
- **Shopify Partner development store**, one per simulated client. Use 2 stores to prove isolation.
- **Airtable** base "OrderPilot Test" with an Orders table (Shopify Order ID, Status, Total).
- **Slack** test workspace with `#store-a-orders` and `#store-b-orders`.

### 2.2 Test matrix (run locally with `.env`, then again on Embarko)
| # | Action | Expected in OrderPilot |
|---|---|---|
| 1 | Place an order in store A | New event, Airtable success, not in the open queue, visible in Activity |
| 2 | Rename the Airtable "Total" column, then place an order | Failed: *Action required — Airtable upsert failed*. Rename it back, approve the retry, it resolves, 2 attempts recorded |
| 3 | Cancel an order with the Slack channel archived | Shopify `Cancelled` and sync `Failed`. Airtable preserved, only Slack retried after unarchiving |
| 4 | Re-run the same viaSocket execution | Duplicate linked, no new Airtable row, no second Slack message (check Slack) |
| 5 | Send a webhook without an event ID | Uncertain, then review flow |
| 6 | Kill the retry callback (disable the HTTP step) | Stays Retrying, then goes to unknown via the 3.1 timeout |
| 7 | Store B operator tries to open store A's embed | 403 |
| 8 | Bad signature / no bearer | 401 |
| 9 | Revoke the operator's permission between approve and execute | 403, history kept |
| 10 | Restart the Embarko app | Data still there (confirms `DATA_DIR` persists) |

Automated tests to add:
- the bearer-auth webhook path;
- `.env` loading;
- store CRUD;
- the live/demo filter;
- the retry-timeout sweep.

The existing `test/viasocket.test.js` stub-server pattern is reused.

**Exit criteria:**
- All 10 matrix rows pass on Embarko.
- `npm test` is green.
- A screenshot of each row is attached to the PR.

---

## Phase 3 — Improve the current project
In priority order. Each item is one PR-sized change.

1. **Stuck-attempt timeout (correctness).** If no callback arrives within `RETRY_CALLBACK_TIMEOUT_MS` (default 10 min), mark the attempt `unknown`, so it becomes "verify before retry". It runs on read inside `listIssues`/`getIssue`, because Embarko has no background workers. Files: `src/engine/execute.js`, `src/issues.js`.
2. **Unique `attempt_key` index and webhook replay window.** Add a `UNIQUE` index on `attempts.attempt_key`. Signed payloads carry a `ts` and are rejected if older than 5 minutes. Files: `src/db.js`, `src/routes/api.js`.
3. **Real sign-in instead of the role dropdown.** Use email magic link or a password plus a signed session cookie. `actorFrom()` in `src/actors.js` becomes the only place that changes, because every rule already goes through `canExecute`. The demo role switcher is kept only for demo stores.
4. **Live inspection.** For an unknown live outcome, trigger an "Inspect" viaSocket flow: Airtable *find record* by Shopify Order ID, Slack *search messages*. It reports `success`/`not_found` through the same webhook. This replaces the 501 in `engine.inspect` and keeps "verify before retry" true in production.
5. **Connection health per store.** A viaSocket "ping" flow per store, run daily, confirms its Shopify, Airtable and Slack connections still authenticate. The Integrations tab shows the last-verified time per connection.
6. **Ops quality:**
   - CSV export of history per store (client reporting);
   - a data-retention setting;
   - an `/api/health` that checks DB writability;
   - structured request logs;
   - rate limiting on the webhook.
7. **UI:**
   - bulk "retry all eligible for this store" (still a single approval showing every step);
   - the issue URL in the hash so links can be shared in Slack;
   - aging badge ("failed 3h ago").

---

## Phase 4 — Agency use cases beyond order sync (each one runs through viaSocket)

Selection rule: each use case is a failure that agencies actually hit while running many client stores, is not visible in Shopify admin, and fits OrderPilot's core model unchanged. That model is: events, required operations, derived status/priority, fresh approval, preserved successes. Every use case adds new **issue types**, not a new product.

### UC-1 — Silent webhook death: "the store stopped syncing and nobody noticed" (build first)
- **Problem (documented by Shopify):**
  - Shopify retries a failing webhook 8 times over 4 hours. If failures persist, it **removes the subscription**, and the store then receives no deliveries until someone re-creates it.
  - The warning email goes to the **Partner account's API contact email**, not the merchant. That is often a freelancer or an ex-employee of the agency.
  - Auto-deletion applies to Admin-API-created subscriptions, which is how most integration tools register webhooks.
  - Shopify staff recommend a periodic API reconciliation job as the backstop.
- **Why it hurts agencies:**
  - It produces no error anywhere. The Airtable/ERP sheet just quietly stops growing.
  - The client notices days later, during month-end reconciliation, and blames the agency.
  - With 30 stores, nobody eyeballs every store's sheet daily.
- **viaSocket flow ("Coverage reconciler", one per store, hourly schedule):**
  1. Shopify *List orders* updated in the last 2h.
  2. POST `{store_id, window_start, window_end, shopify_order_ids:[...]}` to a new `POST /api/webhooks/viasocket/coverage`.
- **OrderPilot changes:**
  - Compare the order IDs with the events received in that window. Each missing order becomes a **Coverage gap** issue: Investigate now, "Order seen in Shopify but no sync event received — webhook subscription may have been removed".
  - Several gaps for one store inside one window roll up into one **Store-level incident**, "Store X: 14 orders in 2h never reached the pipeline", shown at the top of the dashboard.
  - Recovery plan is **Backfill**: run the existing created/cancelled workflow for each missing order through the retry flows. Airtable upsert by Shopify Order ID keeps this idempotent. Slack is suppressed for backfills older than 24h (the plan shows it as a material plan difference). It needs one fresh approval and lists every order.
  - Also add a "Re-register webhook" viaSocket action as a separate approved step, so the root cause is fixed, not just the symptom.
- **Data model:**
  - new table `coverage_runs(store_id, window, seen, received, gaps)`;
  - new event type `backfill` with its required ops defined in `src/rules/workflows.js`.
- **Success metric:** median time from webhook death to detection drops from days to ≤1 hour.

### UC-2 — Paid but never reached the warehouse (3PL hand-off drift) and the late-cancel race
- **Problem:**
  - Agencies wire Shopify to a 3PL/WMS (ShipStation, ShipBob, a custom warehouse sheet) through apps or automation.
  - When that hand-off fails, the order is paid and the customer is waiting, but Shopify shows only "Unfulfilled", the same as every healthy order in the first hours.
  - The mirror-image failure: a customer cancels, but the warehouse has already picked or shipped, because the cancellation never reached them. The merchant pays for shipping, the refund and a return.
- **Why it's not obvious:** neither failure shows up as an error in Shopify. Both only show up as a time-based gap between two systems, and that is exactly OrderPilot's job.
- **viaSocket flows:**
  - *Order created → push to 3PL* reports `{destination:"3pl", result}` as a third required operation, configurable per store.
  - A scheduled per-store flow lists "paid, unfulfilled, older than the store's SLA" orders and asks the 3PL for each order's status. Orders missing at the 3PL are reported.
  - On `orders/cancelled`: query the 3PL status first. If it is picked or shipped, report it so OrderPilot raises **Late cancellation**.
- **OrderPilot changes:**
  - Per-store, configurable required operations: add `3pl` to the workflows table. Today `WORKFLOWS` is global; it becomes a default with per-store overrides.
  - New priority reasons: "Paid 26h ago, not at warehouse (SLA 24h)" (Action required) and "Cancelled after warehouse pick: intercept shipment" (Investigate now).
  - The recovery plan for a late cancel is an **intercept request**: Slack DM to the warehouse contact plus a 3PL hold call. Approved and tracked like any other operation. It never assumes the shipment can be stopped, which follows the in-flight rule in spec §6.

### UC-3 — Discount-stacking / pricing-error order spike during campaign launches
- **Problem:**
  - Shopify lets discounts combine (product + order + shipping combinations). Agencies set up flash sales, BFCM or influencer codes for many clients, often the night before launch.
  - A wrong combination setting, or an automatic discount that overlaps a code, produces a burst of orders at 70–100% off.
  - These orders are valid in Shopify. They become real losses once fulfilled, and on a launch day hundreds can come in within an hour.
- **Why it's specific to agencies:** the person who configured the discount (the agency) is not the person who watches orders (the client), and nobody is watching at 2am launch time.
- **viaSocket flow:** in the Order created flow, add a code step computing `discount_ratio = total_discounts / subtotal_before_discounts` plus the discount codes used. It is included in the report payload.
- **OrderPilot changes:**
  - New rule: a per-store threshold (default 60%). One order above it is Monitor. **N orders above it within 30 minutes sharing the same code** is a store-level **Pricing incident**, Investigate now. It shows the code, the order count and the estimated discount value.
  - The approved plan has three steps, each tracked separately: (a) tag the affected orders `orderpilot-hold` and put fulfillment holds on them via Shopify, (b) Slack the client channel, (c) optionally *disable the discount code* via the Shopify Admin API. Disabling the code is a material, separate step, so it must be explicitly approved.
  - Successes are preserved. If the hold succeeds and the code disable fails, only the disable is retried.

### UC-4 — Connection decay: integrations owned by people who left, or channels clients archived
- **Problem:**
  - Agency automations authenticate as **a person**: an Airtable token, a Slack app install, a Google account.
  - When that employee leaves or the token expires, every flow using it breaks at once, across several clients.
  - Separately, clients rename or archive the Slack channel the agency posts to (Slack returns `channel_not_found` / `is_archived`). Cancellation alerts then silently stop.
  - Both look like random failures, store by store, until someone notices they share one cause.
- **viaSocket flow:** the daily connection-health ping (Phase 3 item 5) reports per-connection status plus the connection label/owner recorded at setup.
- **OrderPilot changes:**
  - **Root-cause grouping.** When failures across stores share a connection or error class (same Airtable token, `channel_not_found`), OrderPilot shows one **Shared cause** incident: "7 failures across 3 stores — Airtable connection owned by j.doe@agency (revoked)". The individual issues stay unchanged underneath it.
  - The recovery plan is "re-authenticate in viaSocket Embed" (deep link to that store's embed), then **bulk retry** of only the dependent failed ops, with one approval.
  - An offboarding checklist in the Team tab lists every store connection owned by a team member before their access is revoked.

### What we deliberately do not build
Generic "order analytics", review requests and abandoned-cart emails. Many tools already do these well, and they don't use OrderPilot's core strengths: multi-store visibility, trustworthy history, safe recovery.

### Validation before building Phase 4
- Show 2–3 agencies the UC-1 to UC-4 one-pagers. Ask each one the last time it happened and how long it took to notice.
- Build UC-1 first: it is documented by Shopify, needs no new destination, and reuses the existing backfill-by-upsert idempotency.
- Then build whichever of UC-2/3/4 scores highest.

---

## Critical files (summary)
- `src/config.js`: `.env` loading, embed decoupled from live mode, new timeouts.
- `src/viasocket/embedToken.js`: `name` / `exp` claims.
- `public/app.js`: `mountEmbed()` matched to the snippet, custom parameters, stores UI, live/demo toggle.
- `src/routes/api.js`: bearer auth, store CRUD, `/webhooks/viasocket/coverage`.
- `src/rules/workflows.js`: per-store required ops, `backfill`, `3pl`.
- `src/rules/priority.js`: new issue reasons.
- `src/issues.js`: incidents and grouping.
- `src/engine/execute.js`: timeout sweep, live inspect.
- `src/db.js`: stores columns, `coverage_runs`, unique `attempt_key`.

## Verification
- Phase 1: signed and bearer test POSTs, and the embed opening for a live store.
- Phase 2: the 10-row matrix on Embarko plus `npm test`.
- Phase 3: each item ships with tests in `test/`.
- Phase 4 UC-1: disable store B's webhook in Shopify, place 3 orders, run the reconciler, and see one store incident with 3 gaps. Approve the backfill: 3 Airtable rows with no duplicates (check Airtable), and no Slack messages for backfills older than 24h.

## Sources used for UC-1 / embed facts
- [Shopify — Troubleshoot webhooks](https://shopify.dev/docs/apps/build/webhooks/troubleshoot)
- [Shopify community — Webhook deletion tracking](https://community.shopify.dev/t/webhook-deletion-tracking-inquiry/24885)
- [viaSocket — Generate JWT Token](https://viasocket.com/faq/viasocket-embed/generate-jwt-token)
- [viaSocket — Custom parameters in Embed SDK](https://viasocket.com/faq/viasocket-embed/custom-parameters-in-embed-sdk)
- [viaSocket — Embed FAQs](https://viasocket.com/help/viasocket-embed/embed-faqs-1)
