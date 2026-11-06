# Analytics time series: Work 87

This work covers module-16 §8 (`analytics_snapshots`, "precomputed dashboard aggregates"), §9.7
(`GET /admin/analytics/*`, "cached snapshots") and the layout's `SnapshotScheduler`. The overview
(Work 08) counts current state only, so a trend needs yesterday's figures. This work stores them.

## Snapshots

- **What is stored.** The overview's six sections are flattened into dotted metric keys, one per
  number:
  - a plain number becomes a metric at its path, e.g. `accounts.total` or `cod.expectedAmount`;
  - a breakdown becomes one metric per label, e.g. `orders.orders.byStatus.DELIVERED` or
    `delivery.drivers.byAvailability.ONLINE`.

  `generatedAt` is not stored. Amounts stay in minor units (santim).
- **Where.** `dashboard_metrics` holds one row per metric per UTC day (`windowStart` is midnight
  UTC, `windowEnd` is the next midnight), with `dimension = 'all'`.
  - This is the read-model table the initial schema already defines, Admin's own, so **no
    migration** was needed. The design calls it `analytics_snapshots`.
  - The dimension is folded into the key because the table's unique key
    (metricKey, dimension, windowStart) would let a NULL dimension write a day twice.
- **When.**
  - **The job.** `AnalyticsSnapshotJob` runs at start-up and then hourly, in server processes
    only (`runsBackgroundJobs`).
  - **Manual.** `POST /admin/analytics/snapshots` takes one on demand.
  - **Same day.** Every run replaces the current day's values, so the day's figure is the last
    run before midnight UTC. A restart loses at most the hour since the last run.
  - **Idempotent by construction.** Running twice on one day leaves one row per metric.
- **Audit.** A manual run records `ANALYTICS_SNAPSHOT_TAKEN` (resource `AnalyticsSnapshot`, id
  the day). The job writes no audit entry because it changes no business state. It writes only
  Admin's own cache of figures that the owners serve anyway.

## Reading

Every route needs `analytics:read`: ADMIN, and SUPER_ADMIN by wildcard.

- `GET /admin/analytics/metrics` returns the keys the snapshots hold, sorted.
- `GET /admin/analytics/timeseries?metrics=a,b&from=YYYY-MM-DD&to=YYYY-MM-DD` returns one series
  per metric, with one point per day of the range.
  - **Gaps.** A day without a snapshot is `null`, never a guessed zero.
  - **Defaults.** With no dates, the range is the 30 days ending today (UTC).
  - **Limits.** At most 8 metrics and 366 days.
  - **Errors.** A reversed, impossible or malformed range is `VALIDATION_ERROR` (400).

## Portal

The admin Analytics page (not the Dashboard) shows a **Trends** section with four line charts:
orders, accounts and pharmacies, delivery, and COD cash in birr. It has a 7, 30 or 90-day range
and a "Snapshot now" button. A gap breaks the line. A chart with no snapshots says so.

## Not built

- **History.** Days before the first snapshot cannot be rebuilt: the owners keep current state,
  not history, so trends start on the day this is deployed.
- **Per-period figures.** Examples are orders created per day, revenue per day and rates. A
  snapshot is a count of state at a moment, not a count of events in a window.
- **Analytics store.** A dedicated warehouse or replica (module-16 §14) stays future work.
  `dashboard_metrics` is the interim the design names.
