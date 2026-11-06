# General disputes — Work 86

module-16 §7, §9.6 (`CRUD /admin/disputes`, `.../message`, `.../resolve`), §11.4 and BRULE-50.
Module-16 open question 5 (SLAs, escalation, remedies) is answered with the owner's requested
recommended option; each choice below can be revisited.

## Cases

- **Intake.** A customer opens a case about their own order (`POST /disputes`), or an administrator opens
  one on the customer's behalf (`POST /admin/disputes`, may set the priority). Topic: `ORDER`, `DELIVERY`,
  `PAYMENT` or `CONTENT`. `APPOINTMENT` is out of scope with Modules 09–12. Someone else's order reads
  as `NOT_FOUND`, so its existence never leaks. One open case per order and topic (a partial unique
  index); a second complaint is told the open case's number (`CONFLICT`).
- **Case number** `DSP-YYYYMMDD-XXXXXX`, shown to the customer.
- **Statuses.** `OPEN → INVESTIGATING ⇄ ESCALATED`, `OPEN → ESCALATED`, any open status → resolve →
  `RESOLVED` (or `RESOLUTION_PENDING` while a refund awaits a second officer), `RESOLVED → CLOSED`.
  Anything else is `INVALID_DISPUTE_STATE_TRANSITION` (409). Closed cases take no messages.
- **SLA (response targets).** URGENT 4 h, HIGH 24 h, NORMAL 72 h, LOW 7 days, from opening; a priority
  change recomputes it. Overdue cases are flagged (`overdue`, `?overdue=true`), not auto-escalated:
  escalation stays a human decision.
- **Thread.** Messages from the customer and from support; administrators can add internal notes the
  customer never sees.

## Resolution (BRULE-50)

`POST /admin/disputes/{id}/resolve` `{ action, notes, amount?, destination? }` (`Idempotency-Key`):

- `NO_ACTION` — resolved with the notes.
- `REFUND` — Work 84's `REFUND_HIGH_VALUE` action through the maker-checker gate, on the order's
  captured payment (found through Module 07's finance port). Needs `finance:refund:any` as well.
  At or below `approvals.highValueRefundThreshold` the refund is carried out and the case is
  `RESOLVED`; above it the case is `RESOLUTION_PENDING` until a second finance officer approves, and the
  approval's execution resolves the case. A rejected, failed or expired approval leaves it resolvable
  again; a pending one blocks another resolution.

The resolution (`action`, `notes`, `refund`, `approvalId`, `resolvedBy`) is written once. The customer
sees only the action.

## Permissions

- `dispute:manage:any` — the desk: ADMIN and FINANCE_OFFICER (SUPER_ADMIN by wildcard). Only a refund
  resolution needs the finance permission.
- `dispute:create:own` — CUSTOMER: open, list and read their own cases, and write in their threads.

## Audit and notifications

`DISPUTE_OPENED`, `DISPUTE_UPDATED`, `DISPUTE_MESSAGE_ADDED`, `DISPUTE_RESOLUTION_PENDING`,
`DISPUTE_RESOLVED` (hash-chained). `admin.dispute.opened` and `admin.dispute.updated` on the outbox; the
latter becomes the complainant's `DISPUTE_UPDATED` notification for every status change and every
support reply (never for an internal note).

## Found while building

`orders.paymentId` is never written by Module 06 (it is always `null`), so an order's payment is read
from Module 07 instead. Recorded for the Phase 1 audit.

## Not built

- Remedies other than a refund (re-delivery, account penalty, catalogue/review action): recorded as
  `NO_ACTION` with notes until those modules expose the commands.
- Attachments on messages.
