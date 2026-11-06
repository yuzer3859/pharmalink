# Reports: Work 90

This covers module-16 §9.5 (`/admin/finance/reports`: "GMV/revenue/reconciliation"), F-AD-23/24
(operational and finance dashboards) and BR-AD-05/07 ("view financial reports", "access platform
analytics and reports"). The design gave no detail on reports, so each choice below is the
recommended option and can be revisited.

## Shape

Reports are **asynchronous CSV exports**:

1. `POST /admin/reports` `{ type, from, to }` with an `Idempotency-Key` header queues a job and
   answers **202**. Replaying the same key with the same request answers 200 with the same job;
   the same key with a different request is `IDEMPOTENCY_CONFLICT` (409).
2. `ReportWorkerJob` runs every 5 seconds in server processes and builds up to 5 queued jobs per
   tick. For each job it:
   - claims it with a compare-and-set on its status, so two instances never build the same one;
   - reads the data page by page (100 rows per page) through **the owning module's read port**;
   - writes a CSV;
   - stores the CSV in document storage under namespace `reports` (Work 89).
3. `GET /admin/reports` and `GET /admin/reports/{id}` show the caller's own jobs: `QUEUED`,
   `RUNNING`, `SUCCEEDED`, `FAILED`, or `EXPIRED` (after the retention period).
4. `POST /admin/reports/{id}/download` returns a **five-minute signed link** to the file.

Admin keeps the job row in `report_jobs` (additive migration `20261107000000_module16_report_jobs`),
never the file.

## Types

| Type | Read through | Columns | Needs, besides `report:generate:any` |
|---|---|---|---|
| `PAYMENTS` | Module 07 `FINANCE_OVERSIGHT_PORT.listPayments` | id, order, customer, amount (santim), currency, method, status, provider, provider ref, authorised, captured, failure, created | `finance:report:any` |
| `REFUNDS` | Module 07 `FINANCE_OVERSIGHT_PORT.listRefunds` | id, payment, amount (santim), currency, type, destination, status, provider ref, reason, approver, created, completed | `finance:report:any` |
| `ORDERS` | Module 06 `ORDER_OPERATIONS_READ_PORT.listOrders` | id, number, status, COD, total (santim), currency, lines, fulfilments, placed, created | `order:read:any` |
| `AUDIT` | `AUDIT_READ_PORT.search` | id, time, actor, action, resource type and id, IP, hash | `audit:read:any` |
| `ANALYTICS_DAILY` | Work 87's `dashboard_metrics` | date, metric, value | `analytics:read` |

The audit report carries no `context`, because that free-form JSON may hold personal data.
Settlements have no list read port yet, so a settlement report waits for one.

## Rules

- **Period.** Inclusive UTC dates, at most 366 days. A malformed, impossible or reversed range is
  `VALIDATION_ERROR`.
- **Snapshot moment.** A report reads only what existed when its build started. This keeps
  newest-first pages stable while new rows arrive.
- **Size.** At most **100,000 rows**. Past that the file ends and the job says `truncated: true`;
  the portal asks for a shorter period.
- **CSV format.** RFC 4180 quoting, CRLF line endings, and a UTF-8 byte-order mark so spreadsheet
  programs read Amharic correctly.
- **Formula neutralising.** Any text cell starting with `=`, `+`, `-`, `@`, a tab or a CR is
  prefixed with `'`. This prevents CSV injection (OWASP).
- **Retries.** A build that throws is retried, up to 3 attempts, and then marked `FAILED`. The
  portal shows only "could not be built"; the stored error stays internal. A `RUNNING` job
  older than 15 minutes is assumed abandoned and queued again.
- **Retention.** A finished report can be downloaded for **7 days**, then it reads `EXPIRED`.
  Deleting the file itself waits for storage lifecycle rules, which are part of the production
  storage decision (backend/docs/document-storage.md).

## Who

**`report:generate:any`** is a new key held by ADMIN and FINANCE_OFFICER (and SUPER_ADMIN by
wildcard).
- **Per-type permission.** Every type also needs that data's own read permission (table above),
  so a finance officer can run payments and refunds only.
- **When it is checked.** Both permissions are checked when the report is requested **and again on
  download**, using the caller's current token. A revoked permission therefore stops the download.
- **Ownership.** People see and download only their own reports; anyone else's reads as `404`.
- **Audit.** `REPORT_REQUESTED` and `REPORT_DOWNLOADED`. The signed link is never written down.

## Portal

The **Reports** page in the admin, super admin and finance portals has:
- a form offering only the types the caller may run, with dates;
- the caller's reports, polled every 3 seconds while one is building;
- a "Download CSV" button that opens the signed link.

The pharmacy portal keeps its own Reports page, which is outside Module 16.

## Not built

- **Scheduled reports** and e-mailing a report.
- **Other formats.** PDF and XLSX are not built.
- **Settlement and reconciliation reports.** These need a settlement list port and a
  reconciliation read model.
