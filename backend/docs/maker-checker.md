# Maker-checker (two-person approval) — Work 82

NFR-SEC-06 and module-16 §11.2. One administrator (the **maker**) asks for a sensitive action; a
**different**, authorised administrator (the **checker**) approves or rejects it; only an approval
runs the action, and it runs through the owning module's own command. Works 83 (settlements) and
84 (high-value refunds) are the first actions that use it.

## What is built here

| Piece | Where |
| --- | --- |
| Approval requests, stored | `approval_requests` (the Phase 0 `ApprovalRequest` table, extended additively) |
| Action registry | `MakerCheckerActionRegistry` — an owning module's adapter registers one `MakerCheckerAction` per action type |
| Gate | `MakerCheckerGate.submit()` — the one call a maker-facing route makes. Runs the action now, or records a pending request |
| Decision | `DecideApprovalCommand` — `POST /admin/approvals/{id}/decide` |
| Expiry | `ApprovalExpirySweeper` (60 s timer, off in CLI processes) plus a check at decision time |
| Reads | `GET /admin/approvals`, `GET /admin/approvals/{id}` |
| Portal | "Pending approvals" page in the Admin, Super Admin and Finance portals |

## Rules

1. **Which actions need a checker is configuration**, not code: `approvals.makerCheckerActions`, a
   list of action types (environment `APPROVALS_MAKER_CHECKER_ACTIONS`, comma-separated; governed
   through `PUT /admin/config/approvals/makerCheckerActions`). Only registered action types are
   accepted (`MAKER_CHECKER_ACTION_TYPES`). An action type that is not listed runs at once
   through the same executor, so the two paths cannot drift. The default is an empty list:
   Work 82 changes no existing behaviour.
2. **Maker ≠ checker.** The maker can never decide their own request
   (`MAKER_CHECKER_SELF_APPROVAL`, 403), whatever roles they hold — Super Admin included.
3. **The checker must hold the action's own permission** (for example `finance:refund:any`). The
   route needs `approval:read:any`; the action permission is checked in the command, with the
   checker's permissions from the token.
4. **Expiry.** A request expires `approvals.ttlHours` after it was made (default 72, bounds 1–720;
   `APPROVALS_TTL_HOURS`). An expired request cannot be decided (`APPROVAL_EXPIRED`, 409); the
   sweeper and the decision both persist the `EXPIRED` status and audit it.
5. **Reject needs a reason** (`VALIDATION_ERROR`). Approve may carry a note.
6. **One open request per action and target.** A partial unique index on
   `(actionType, entityId) WHERE status = 'PENDING'` stops two makers queueing the same payout;
   the second is told `CONFLICT` with the open request's id.
7. **Maker retries are idempotent**: `(requestedByUserId, actionType, makerIdempotencyKey)` is
   unique. The same key with the same payload returns the existing request; a different payload is
   `IDEMPOTENCY_CONFLICT`.
8. **Execution is idempotent.** The executor always receives the idempotency key
   `approval:<id>`, so the owning module's own idempotency (BRULE-25) makes a repeat harmless.
   The decision commits `APPROVED` first, then executes, then records the outcome:
   - success → `executedAt`, `executionResult`; audit `APPROVAL_EXECUTED`.
   - the owning module refuses (an `ApiException`) → `FAILED`, `executionError`; audit
     `APPROVAL_EXECUTION_FAILED`; the checker gets `RESOLUTION_ACTION_FAILED` (422) with the
     module's code. Admin cannot force past a domain invariant.
   - anything else (database down, crash) → the request stays `APPROVED` with no `executedAt`.
     Deciding it again with `APPROVE` resumes execution with the same key.
   - deciding an already-decided request the same way again returns the stored outcome; deciding
     it the other way is `APPROVAL_ALREADY_DECIDED` (409).
9. **Every step is audited** in the hash-chained log, with both parties: `APPROVAL_REQUESTED`,
   `APPROVAL_APPROVED`, `APPROVAL_REJECTED`, `APPROVAL_EXPIRED`, `APPROVAL_EXECUTED`,
   `APPROVAL_EXECUTION_FAILED`. Requests and decisions also go to the outbox
   (`admin.approval.requested`, `admin.approval.decided`).
10. **Payloads hold what the executor needs and nothing secret** — ids, amounts, a reason. They are
    shown to the checker, because the checker must see what they approve.

## Registered actions

| Action | Owner | Permission | Gated | Work |
| --- | --- | --- | --- | --- |
| `SETTLEMENT_APPROVE` | Module 07 | `finance:settlement:any` | always, when listed | 83 ([settlement-payout.md](settlement-payout.md)) |
| `SETTLEMENT_PAYOUT` | Module 07 | `finance:payout:any` | always, when listed | 83 |
| `PAYOUT_BENEFICIARY_VERIFY` | Module 07 | `finance:payout:any` | always, when listed | 83 |
| `REFUND_HIGH_VALUE` | Module 07 | `finance:refund:any` | only above `approvals.highValueRefundThreshold` | 84 |

All four are listed by default. An action may answer per request whether it needs a checker
(`needsApproval`); the gate asks only when the action is listed.

## High-value refunds (Work 84)

- `POST /admin/finance/payments/{id}/refunds` (`finance:refund:any`, `Idempotency-Key`): a manual
  refund from the finance portal. At or below the threshold it runs at once (200); above it, 202
  `MAKER_CHECKER_PENDING` and a second finance officer decides on the Approvals page.
- `approvals.highValueRefundThreshold`: santim, default 1,000,000 (10,000 birr; the owner asked for
  the recommended default), bounds 1 to 2,147,483,647, `APPROVALS_HIGH_VALUE_REFUND_THRESHOLD`.
  "Amount omitted" means everything still refundable, and the decision uses that amount.
- Module 07's own `POST /payments/{id}/refunds` refuses a single-actor refund above the threshold
  (`REFUND_APPROVAL_REQUIRED`, 409) inside the refund's own reservation, before anything is written.
  Only the maker-checker executor can pass the approval through, so no route skips it.
- The refund's `approvedBy` is the checker; its idempotency key is `approval:<id>`.

## Known limits

- A Super Admin can change `approvals.makerCheckerActions` alone (config publishing is itself a
  single-actor, audited action). Putting configuration changes behind maker-checker is a
  separate decision (module-16 open question 2).
- There is no "cancel my request"; an unwanted request is rejected by a checker or expires.
