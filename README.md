# OrderPilot — Order Operations Hub

Agency-wide visibility and **safe, understandable recovery** of order-sync issues across many client Shopify stores. viaSocket runs the workflows (Shopify → Airtable / Slack); OrderPilot shows what failed, what is uncertain, and lets an authorized operator recover only what needs recovery.

Product decisions live in [`OrderPilot_Full_Context.md`](OrderPilot_Full_Context.md). This app implements them.

> **Demo-first.** Out of the box everything is synthetic: 3 client stores, 20 orders, deterministic failure/recovery scenarios, simulated destinations. The viaSocket path is built in and switches on with `VIASOCKET_MODE=live` once credentials exist.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
npm test             # 33 tests: rules, every scenario, roles, resets, webhook, embed token
```

Node 20+. Data goes to `DATA_DIR` (default `./data/orderpilot.db`) and is seeded automatically on first boot.

## Demo walkthrough (Definition of Done)

1. The landing page is the populated **Issues** dashboard, sorted by priority (Investigate now → Action required → Monitor), then by recency. You can filter by client store or sync status.
2. Open **Northstar Goods #1004**. Shopify status (`Open`) and overall sync status (`Failed`) are shown separately, with a per-destination breakdown and the full attempt history.
3. **Prepare recovery plan → Approve & execute now.** The retry fails again (scenario A). Approve again (every execution needs fresh approval) and it succeeds. The issue becomes **Resolved** and moves to **Activity**, with all 3 attempts kept.
4. **#1019 (Harbor & Pine)** has no stable event ID. Review the evidence (closest match, prior outcomes, side-effect risk), then classify it as duplicate or new, with a rationale. If new, a plan and a fresh approval follow.
5. **#1006 / #1014** have timed-out outcomes. **Inspect destination outcome** before any retry.
6. **#1007**: the Airtable cancel update is preserved and only Slack is retried. **#1020**: Airtable failed and Slack is unknown, so the status is `Failed`. Inspect Slack: the message was already posted, so it is never resent.
7. **Simulate redelivery** on any confirmed event (scenario C). The delivery is linked to the existing history and nothing is repeated.
8. **Reset this scenario** replays one issue. **Reset workspace** (with confirmation) restores everything.

Switch **Acting as**:
- **Ines** (investigator): can inspect and review, but cannot execute.
- **Omar** (operator): can execute for Northstar and Studio only.
- **Ada** (admin): has all stores and manages permissions in **Team**.

The optional **Guided tour** walks through steps 2–3.

| Seeded scenario | Orders |
|---|---|
| Healthy | 1001–1003, 1008–1011, 1015–1017 |
| A: Fail → Fail → Succeed | 1004 |
| D: persistent failure → manual review | 1012 |
| Failed, one retry fixes | 1013, 1018 (Harbor: Omar can't execute) |
| B: timeout, inspection confirms applied / not applied | 1006 / 1014 |
| Cancellation: Slack failed / Airtable failed + Slack unknown | 1007 / 1020 |
| C: duplicate delivery linked | 1005 |
| Missing event ID → uncertain review | 1019 |

## Architecture

```
public/            plain HTML/CSS/JS UI (no build step, polling — no WebSockets)
server.js          Express app: /api + static
src/rules/         status precedence, priority, dedup, per-workflow required ops (pure, unit-tested)
src/engine/        plan (only non-confirmed ops), approve/execute (fresh approval, permission recheck,
                   per-op lock), ingest (webhook + review)
src/adapters/      simulated (scripted, deterministic) and viasocket (live single-op retry)
src/viasocket/     embed JWT + webhook HMAC verification
src/db.js, seed.js SQLite under DATA_DIR, deterministic baseline, per-order and full reset
```

There is one source of truth. Issues, statuses, priorities, dashboard totals and the side panel are all **derived** from the events → operations → attempts rows, so they cannot drift apart.

## How viaSocket is embedded

viaSocket is the execution layer and OrderPilot is the visibility and recovery layer. The connection between them has three parts.

### 1. Embedded Integrations page (per-store isolation)
The **Integrations** tab shows a *Manage integrations* button for each client store. The server signs a viaSocket Embed token, an HS256 JWT with exactly `{ org_id, project_id, unique_identifier: "store_<storeId>" }` and no `exp`, signed with `VIASOCKET_EMBED_SECRET`. The page then mounts viaSocket's prebuilt UI with `viaSocket.mount()`. Because `unique_identifier` is the **store**, every client store gets its own isolated Shopify, Airtable and Slack connections and flows inside viaSocket. Tokens are only issued to operators and admins who have permission for that store. The embed works whenever the three credentials are set, regardless of `VIASOCKET_MODE`. Locally, put them in `.env`; the app loads it on start. The secret never reaches the browser.

### 2. Flows report results to OrderPilot
Set up these flow templates once in your viaSocket Embed project:

- **Order created** → Airtable *upsert* keyed by Shopify Order ID → HTTP step to OrderPilot
- **Order cancelled** → Airtable *update* (status = Cancelled) + Slack message → HTTP step to OrderPilot

The final HTTP step POSTs to `https://<your-app>/api/webhooks/viasocket`. It sends the header `X-OrderPilot-Signature: <hex HMAC-SHA256 of the raw body using VIASOCKET_WEBHOOK_SECRET>` and this body:

```json
{
  "store_id": "s_northstar",
  "event_id": "<Shopify webhook ID / X-Shopify-Event-Id>",
  "shopify_order_id": "5800001234",
  "order_number": "#1234",
  "event_type": "created | cancelled",
  "operations": [
    { "destination": "airtable", "result": "success | failed | unknown", "detail": "...", "execution_id": "<viaSocket run id>" },
    { "destination": "slack",    "result": "success | failed | unknown", "detail": "...", "execution_id": "..." }
  ]
}
```

OrderPilot handles these reports with the same dedup rules as the demo:
- **Same `event_id` and store**: the delivery is a duplicate and is linked to the existing history.
- **Missing `event_id`**: identity is uncertain and goes to review.
- **Missing result** for a required operation: the outcome is recorded as `unknown`.

### 3. Single-operation retries
Create one webhook-triggered flow per destination: *Retry Airtable upsert/update* and *Retry Slack notify*. Put their trigger URLs in `VIASOCKET_RETRY_AIRTABLE_URL` and `VIASOCKET_RETRY_SLACK_URL`.

When an operator approves a retry of a live event:
1. OrderPilot POSTs `{ attempt_key, operation_id, destination, kind, target_ref, store_id, event_id, shopify_order_id, slack_channel, callback_url }` to **only** the failed operation's flow.
2. The attempt stays **Retrying**, and is locked against concurrent retries, until the flow calls back to the same webhook with `{ "attempt_key": "...", "result": "success|failed|unknown", "detail": "...", "execution_id": "..." }`.

viaSocket accepting the request is never treated as proof of success. Duplicate callbacks are ignored.

Synthetic demo events always use the simulated adapter, even in live mode, so demo data never triggers real side effects.

**Confirm before going live:** check the Embed script URL (`VIASOCKET_EMBED_SCRIPT_URL`), the script tag attributes and the JWT claim names against your viaSocket dashboard (Embed → Settings). They are each set in one place: `src/viasocket/embedToken.js` and `mountEmbed()` in `public/app.js`.

## Deploying on Embarko

1. Re-check the current Embarko capabilities (`https://ship.embarko.ai/capabilities`): the Node runtime, `PORT`, a persistent `DATA_DIR`, and secrets.
2. Deploy as a single Node web service. Install with `npm ci` and start with `npm start`. The app listens on `$PORT`, writes only under `$DATA_DIR`, and seeds itself on first boot. The health check is `GET /api/health`.
3. Set the env vars and secrets listed in [`.env.example`](.env.example). Keep `VIASOCKET_MODE=simulated` until the viaSocket values exist.
4. When going live:
   1. Set `PUBLIC_URL` and the `VIASOCKET_*` values, then set `VIASOCKET_MODE=live`.
   2. Point each flow's final HTTP step at `${PUBLIC_URL}/api/webhooks/viasocket`.
   3. Send one signed test delivery and confirm it appears on the dashboard.

## Known production limitations

This is a demo-grade prototype, not a production platform. Before real customer use, revisit:
- **Users and roles are simulated.** The acting user is chosen in the UI and sent as a header. There is no authentication or real server-side authorization yet.
- **Storage is SQLite** with no managed durability, backup or restore. Demo resets intentionally delete data.
- **Store/tenant isolation** exists only at the viaSocket-connection level and in the simulated permission checks.
- **No background workers or job orchestration.** Live retries depend on viaSocket calling back, and in-flight external actions cannot be cancelled.
- **History** explains every decision but is not an enterprise-grade audit log.
