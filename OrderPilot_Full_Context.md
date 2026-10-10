# OrderPilot — Full Product Discovery & Build Context

> Purpose: This document preserves the decisions and context from the OrderPilot product-discovery conversation so work can continue in a new chat without restarting discovery.
>
> Current mode: **Product specification and build planning only. No code has been written or requested in this discovery thread.**
>
> Build target: **A demo-first prototype in approximately 60 minutes.**

---

## 1. Product overview

**Product name:** OrderPilot  
**Product descriptor:** Order Operations Hub  
**Target users:** E-commerce agencies managing multiple client Shopify stores.

### Problem OrderPilot addresses

Agencies need one place to identify and investigate order synchronization failures, duplicate events, uncertain outcomes, and recovery needs across client stores.

The product is not differentiated merely by syncing Shopify with Airtable. Its value is **agency-wide visibility and safe, understandable recovery of synchronization issues across multiple client stores**.

### Future intended integration workflow

The eventual live workflow may include:

- Shopify order created or cancelled.
- ViaSocket processes the event.
- Airtable order record is created or updated.
- Slack receives cancellation notifications.

These integrations are **future scope only** for the prototype described here. Do not connect live services or claim they are operational unless that is explicitly requested and separately implemented.

---

## 2. Prototype boundary and environment

### Demo-first scope

The initial product must use:

- Synthetic orders and client stores.
- Simulated destination operations.
- Deterministic, repeatable failure/recovery scenarios.
- Visible operation history and simulated outcomes.

Do **not** build live Shopify, ViaSocket, Airtable, or Slack integrations in the one-hour prototype.

### Hosting and data

- Intended environment: **Embarko**.
- Reuse the existing project and framework; inspect the current project before making implementation decisions.
- For the disposable prototype, SQLite under `DATA_DIR` is acceptable.
- The prototype accepts data-loss risk. This is not a production durability promise.
- Ordinary HTTP requests and polling are acceptable; do not introduce a WebSocket dependency just for the demo.

### Known production limitations to revisit

Before real customer use, revisit:

- Managed, durable storage.
- Backup and restore.
- Authentication and server-side authorization.
- Tenant/store isolation.
- Reliable background jobs and execution orchestration.
- Handling of external actions already in flight.
- Production-grade auditability and operational reliability.

Prior discussion recorded that Embarko's documented environment had limits around managed backup/restore, end-user authentication, WebSockets, scheduled jobs, and background workers. Treat those as prior discovery notes, and re-check current capabilities if implementation depends on them. A previous note referenced `https://ship.embarko.ai/capabilities` and capability version `2026-10-06`; this is not a guarantee of current availability.

ViaSocket integration checks were described as **verified by the user, not independently re-verified in this conversation**:

1. Shopify event support for new orders and cancellations.
2. Airtable upsert behavior using Shopify Order ID.
3. Slack notification action, inputs, and channel selection.
4. Execution visibility for workflow success/failure/error details.
5. Store isolation through ViaSocket identities/connections.

The prototype should not depend on those live integrations.

---

## 3. Product and UX decisions

### Dashboard

- The default landing page is a **populated, agency-wide Issues dashboard**.
- The dashboard is issues-first, not a generic analytics-first dashboard.
- Show issues across accessible client stores by default.
- Provide client-store and status filters.
- Every issue must clearly show the client store and order context.
- Keep the issue list compact and scannable.
- Sort by risk/severity and required action first, then recency within priority groups.
- Resolved issues leave the active issue queue but remain accessible in Activity/history.

### Issue priority

Use a **priority label plus a short explanation**.

Proposed priority categories:

1. **Investigate now** — e.g. destination outcome unconfirmed or duplicate side-effect risk.
2. **Action required** — e.g. confirmed failure needing safe retry or manual correction.
3. **Monitor** — e.g. a known issue with a safe next step.

Priority is separate from sync status. For example:

- Sync status: `Failed`
- Priority: `Action required — Airtable update failed`

Priority should recalculate when issue state changes.

### Order state vs. sync state

Display Shopify order status and destination synchronization state independently.

Example:

- Shopify order status: `Cancelled`
- Overall sync status: `Unresolved`

A failed sync must never imply that the Shopify order itself failed to cancel.

### Overall status in the issue list vs. side panel

- Issue list: show the **overall sync status** only.
- Investigation side panel: show destination-specific states for Airtable, Slack, and any other required destination.
- Overall sync status is derived from required destination outcomes; it is not manually edited.

### Status precedence and semantics

Locked policy:

- If any required destination operation has a **confirmed failure**, overall status is `Failed`.
- If no required operation has a confirmed failure but an outcome is unknown, overall status is `Unresolved`.
- If an operation is actively being retried, `Retrying` may be shown while preserving underlying risk and attempt history.
- `Resolved` only when every required operation for that workflow is confirmed successful.

If one operation failed and another is unknown, confirmed failure takes precedence and the overall status is `Failed`. Unknown outcomes must still be represented at the operation level.

A successful click or accepted retry is not proof of success.

### Required operations per workflow

Required operations are defined explicitly per workflow.

**New order created**
- Required: Airtable upsert, using Shopify Order ID as the stable order-record key.
- Resolved only when the Airtable upsert is confirmed.

**Order cancelled**
- Required: Airtable cancellation update.
- Required: Slack cancellation notification.
- Resolved only when both are confirmed successful.

Successful Airtable sync alone does not prove the Slack notification succeeded. Additional event types must explicitly define their required operations before being included.

### Destination detail

- Keep the queue compact with overall status.
- In the side panel show each destination's status, latest known outcome, timestamps, and attempt history.
- Track Airtable and Slack operations independently.
- Destination failures do not change Shopify order status.
- Preserve confirmed success for each operation.

---

## 4. Dataset and deterministic scenarios

### Synthetic dataset

Use exactly:

- **3 synthetic client stores**
  - Northstar Goods
  - Studio Supply
  - Harbor & Pine
- **20 synthetic orders**
- Stable synthetic Shopify Order IDs and stable store associations.
- Deterministic timestamps and scenario histories.
- Dashboard totals calculated from the same underlying data.

Suggested distribution:

| Category | Count |
|---|---:|
| Healthy syncs | 10 |
| Confirmed failures | 4 |
| Unresolved outcomes | 2 |
| Cancellation scenarios | 2 |
| Duplicate-event scenarios | 2 |
| **Total** | **20** |

The categories are intended as a curated distribution of 20 demo orders/scenarios. Cancellation and duplicate scenarios should also demonstrate the corresponding synchronization behavior.

### Recovery scenarios

Predefined, repeatable scenarios—not random results.

**Scenario A: transient failure**
- `Fail → Fail → Succeed`
- Initial attempt plus two retries = 3 attempts total.
- Preserve every attempt.

**Scenario B: ambiguous timeout**
- Operation outcome becomes unknown.
- Issue remains `Unresolved`.
- Inspect simulated destination outcome.
- Resolve only if the outcome is confirmed.

**Scenario C: duplicate event**
- Existing event/order operation is found.
- Link duplicate delivery to existing history.
- Do not create a duplicate order record or repeat a confirmed notification.

**Scenario D: persistent failure**
- Repeated retry fails.
- Issue remains failed and requires manual review.

---

## 5. Recovery and retry rules

### Retry only the operation needing recovery

Locked decision:

- Retry only the failed or unconfirmed destination operation.
- Preserve confirmed successes.
- Do not blindly rerun the entire workflow.
- Verify unknown outcomes before retrying whenever possible.
- Prevent concurrent retry actions for the same operation.
- Show which operation is being retried and why.
- Preserve all attempts and their results.

Example for a cancellation:

- Airtable update: confirmed successful — do not repeat.
- Slack notification: failed — retry only Slack.
- Issue remains unresolved until both required operations are confirmed.

### Duplicate side effects

Duplicate prevention must cover more than Airtable order records:

- Airtable upsert helps avoid duplicate order records.
- It does not by itself prevent duplicate Slack notifications.
- Do not resend a notification already confirmed successful merely because the event was delivered again.
- For an unknown notification outcome, verify where possible before retrying.

### Event identity and deduplication

Primary deduplication identity:

- **Stable event ID + client store ID**.

Supporting context:

- Shopify Order ID.
- Event type.

Rules:

- Same event ID from the same store = duplicate delivery.
- Same event ID from a different store = separate event.
- Different event IDs for the same order remain separate operations.
- Distinct lifecycle events (e.g. order created and order cancelled) must not be collapsed into one event just because the order ID matches.
- Duplicate deliveries should link to existing processing history.

### Missing stable event ID

Locked policy:

- Flag the event for review.
- Mark identity as uncertain.
- Hold potentially duplicate side effects until reviewed.
- Do not assume matching order ID/event type proves a duplicate.
- If classified as a duplicate, link to existing history.
- If classified as new, require explicit confirmation before processing.
- If still uncertain, leave unresolved.

### Evidence shown for uncertain-event review

Show:

- Key event fields.
- Closest matching existing event.
- Timestamps.
- Prior destination outcomes.
- Whether side effects may already have occurred.
- Clear uncertain-identity state.
- Review decision and rationale in history.

Avoid exposing secrets or unnecessary sensitive payload fields.

---

## 6. Operator approval policy

### Approval scope

One explicit confirmation authorizes the **displayed processing plan as a whole**. Each destination operation is still tracked separately.

Before confirmation, show planned operations and destinations.

### Fresh approval before every execution

The latest locked decision is stricter than the earlier approval-validity policy:

- **Require fresh operator approval immediately before every execution**, even if the plan and state appear unchanged.
- This applies to initial processing and each retry.
- Approval authorizes the plan; it does not guarantee success.
- Fresh approval must not cause confirmed successful operations to be repeated.
- A materially changed plan must be shown again and approved.

### Material plan changes

Renewed approval is required if any of these changes:

- Destination.
- Operation.
- Target record.
- Intended side effect.
- Required workflow step.

A retry of the same operation against the same target with the same intent retains the same plan identity, but still requires fresh approval immediately before execution because of the stricter approval-timing decision.

### Uncertain event approved as new

Flow:

1. Operator reviews event evidence.
2. Operator classifies event as new and records rationale.
3. OrderPilot displays planned destination operations.
4. Operator explicitly confirms the plan.
5. Fresh approval is required immediately before the simulated execution.
6. Record each destination result and attempt history.

If the operator cancels, the event remains unprocessed. If the plan materially changes, show the new plan and request approval again.

### Stale state

The latest decision requires fresh approval immediately before every execution even if state appears unchanged. If relevant state or the plan changes, the approval prompt must show the current plan. Do not assume an external action already in flight can be cancelled.

---

## 7. Roles, permissions, and revocation

### Roles

**Investigator**
- Can inspect accessible issues.
- Can inspect event and destination history.
- Can review uncertain events and prepare recovery plans.
- Cannot approve or execute processing/retries.

**Authorized operator**
- Can investigate and prepare plans.
- Can approve execution only for stores where they have explicit execution permission.
- Must give fresh approval immediately before each execution.

### Permission scope and administration

- Execution permissions are **store-scoped**.
- Permission for one client store does not authorize execution for another.
- Operators may investigate more broadly than they can execute.
- Only agency administrators can grant or revoke execution permission individually for each store.
- Permission changes should record administrator, affected team member, store, and change time.
- Revocation does not erase previous approvals, execution history, or completed operation outcomes.

### Revocation during recovery

A final policy choice was still pending at the end of the conversation:
- Recheck permission immediately before every execution.
- Revocation blocks future approvals/executions.
- Completed operations and history remain intact.
- An external operation already in flight may not be cancellable.

The next question at that point was whether revocation should merely block future executions, attempt to cancel in-progress recovery, or allow already-approved recovery to finish. The recommended default was to recheck permission before each execution and block future execution; do not assume in-flight external actions can be cancelled. If proceeding without further user input, AI should resolve this using that recommended default.

These role and permission behaviors can be simulated in the prototype, but they are **not production security** without real authentication and server-side authorization.

---

## 8. Reset and onboarding

### Reset controls

Provide both:

**Per-issue reset**
- Reset only that scenario to its baseline.
- Leave all other issues untouched.

**Full workspace reset**
- Require explicit confirmation.
- Restore all synthetic stores/orders/issues to the original baseline.
- Warn that demo progress and history will be lost.

Reset is demo management, not live recovery.

### First-run experience

- Land directly on the populated Issues dashboard.
- Offer an optional, skippable guided tour.
- No forced onboarding.
- Tour must clearly identify all actions/results as simulations.

### Suggested guided tour

1. Open a failed Airtable sync.
2. Inspect its history.
3. Simulate retries: `Fail → Fail → Succeed`.
4. Confirm simulated resolution.

The tour does not automatically reset or resolve issues; the user performs each action.

---

## 9. Priority and activity history

### Priority categories

1. **Investigate now** — unknown destination outcome or duplicate side-effect risk.
2. **Action required** — confirmed failure requiring retry or manual correction.
3. **Monitor** — known issue with a safe next step.

Show a short reason beside the label. Recalculate priority as state changes.

### Queue sorting

- Sort by risk/severity and required action first.
- Within the same priority group, show most recent relevant activity first.
- Resolved issues leave the active queue but remain in Activity/history.

### History

Keep enough history to explain:
- Event receipt and duplicate detection.
- Per-operation attempts and results.
- Approval and execution decisions.
- Uncertain-event review and rationale.
- Reset behavior where appropriate.

Do not claim enterprise-grade audit guarantees for the prototype.

---

## 10. One-hour implementation plan

**Goal:** A credible, testable demo in approximately 60 minutes, not a production integration platform.

| Time | Phase | Exit criteria |
|---|---|---|
| 00–05 | Inspect project/environment | Know current framework, entry point, and run/deploy process |
| 05–15 | Dashboard and dataset | Populated dashboard, stable synthetic data, working filters, consistent counts |
| 15–27 | Investigation panel | Independent Shopify and sync states, destination breakdown, history |
| 27–42 | Recovery simulation | Complete primary recovery journey, operation-level retries, approval |
| 42–51 | Safety/reset | Uncertain-event review, role simulation, reset controls; tour only if time permits |
| 51–60 | Test/stabilize | End-to-end recovery works, counts and reset remain consistent |

### Priority if time runs short

Preserve:
1. Dashboard.
2. Investigation side panel.
3. One complete recovery journey.
4. Consistent state and history.

Cut first:
- Guided tour.
- Advanced permission UI.
- Secondary visual polish.
- Nonessential screens.

### Build order

1. Inspect the existing project.
2. Define stable data model.
3. Seed deterministic data.
4. Build Issues dashboard.
5. Build investigation panel.
6. Implement status/priority rules.
7. Implement approval and recovery simulation.
8. Add duplicate review and reset.
9. Test end-to-end.

Use one source of truth for orders, events, destination operations, and history. Avoid building dashboard totals, side-panel states, and history independently.

---

## 11. Definition of done

The demo should complete this flow without breaking:

1. Open a populated agency dashboard and identify a high-priority failure.
2. Open the issue and distinguish Shopify order state from destination sync state.
3. Inspect operation history and identify the failed or uncertain operation.
4. For an uncertain event, review matching evidence, classify it, inspect the plan, and obtain simulated approval.
5. Execute a simulated retry with fresh approval.
6. Preserve successful operations and record each attempt.
7. Mark Resolved only when all required operations are confirmed.
8. Reset the issue and replay without inconsistent counts or duplicate history.

---

## 12. Next step

Do not restart product discovery. Inspect the existing Embarko project, confirm the actual framework and entry point, then build in small increments and verify each phase.

If any technical constraint forces a scope change, document the change and preserve the product decisions above. Do not ask the user to decide ordinary implementation details; choose sensible defaults and keep progress token-efficient.

**Critical context:** OrderPilot is an agency-first operations/recovery hub, not just a Shopify-to-Airtable sync demo. The central value is multi-client visibility, trustworthy operation history, safe retry, duplicate prevention, explicit approvals, and clear distinction between order state and sync state.
