# Admin activity and anomaly monitoring: Work 88

This covers module-16 F-AD-27 ("admin activity monitoring (who did what) + anomaly alerts"),
§9.7 (`GET /admin/admins/activity`), §13 ("Admin activity monitoring flags anomalies (e.g.
unusual suspension volume, off-hours access)"), FR-ADM-12 and BRULE-48.

The design left this undetailed (module-16 status: DEFERRED, "not designed in detail"). This note
is that detail. Each choice is the recommended option and can be revisited.

## Who counts as staff

**Staff** means anyone holding a platform role: `SUPER_ADMIN`, `ADMIN`, `FINANCE_OFFICER` or
`CUSTOMER_SUPPORT`.
- **Identified by role assignment, not primary role.** Staff accounts often start as customers,
  so `users.primaryRole` would miss them.
- **Read through Module 01.** Module 01 provides the list through a new inbound port,
  `IDENTITY_STAFF_READ_PORT.listStaff()`, which returns user id, contact and the platform roles
  held. Admin never reads `user_roles`.

## What is read

The activity is each staff member's entries in the hash-chained `audit_logs` within a window:
- **Window.** It defaults to the last 7 days and is at most 31 days.
- **Read path.** The entries come through the shared audit read port, which gains one read:
  `activityOf(actorIds, from, to, limit)`. It returns action, resource, IP and time. It never
  returns `context`, because the free-form JSON can hold personal data and the counts don't need it.
- **Cap.** The read stops at 20,000 entries. The response then says `truncated: true` rather than
  silently under-counting.

Per staff member the response gives:
- their roles;
- the total number of entries;
- counts by action, sorted;
- the first and last entry in the window;
- the number of distinct IPs;
- their flags.

`GET /admin/admins/activity/{userId}` pages that person's entries, newest first, through the
existing `search` read.

## Anomaly rules

The rules are computed on read, so they are always current with the audit log and need no state
of their own. Times are judged in **East Africa Time (UTC+3, no daylight saving)**, the
platform's only time zone.

| Rule | Flags | Threshold |
|---|---|---|
| `OFF_HOURS` | Actions between 22:00 and 06:00 EAT | Any |
| `BURST` | Many actions in a short span (scripted or compromised session) | ≥ 30 entries within 10 minutes |
| `SENSITIVE_VOLUME` | "Unusual suspension volume" and its kin | ≥ 10 sensitive actions within 24 hours |
| `SELF_TARGETED` | A sensitive action on one's own account | Any (resource `user` whose id is the actor) |
| `MANY_IPS` | One account used from many addresses | ≥ 5 distinct IPs in the window |

**Sensitive actions** are:
- account suspension, reactivation and deactivation;
- role assignment and revocation, and role-permission replacement;
- verification approval and rejection;
- configuration changes and feature flags;
- refunds;
- settlement approval and payment, and payout initiation and destination verification;
- impersonation start and authorization;
- dispute resolution;
- the Super Admin bootstrap.

They are listed in `SENSITIVE_ADMIN_ACTIONS`.

Each flag carries:
- the rule;
- a count;
- the first time it occurred;
- up to five example audit entry ids, so a reviewer can open them in the audit explorer.

A flag is a prompt for a human to look, not a verdict. Nothing is suspended automatically.

## Who may read it

`staff:monitor:any`, a new key.
- **Who holds it.** Only `SUPER_ADMIN` holds it, by wildcard. The view watches administrators,
  so an `ADMIN` reading their own oversight would defeat it. Separation of duties again, as in
  Work 82.
- **Audit.** Every read is audited as `ADMIN_ACTIVITY_VIEWED`. The design says "the audit
  explorer itself is read-only and its reads are audited", and this view is a lens over the
  same trail.

## Portal

The super admin portal gets an **Admin activity** page with:
- a window picker;
- one row per staff member, with flags shown as chips;
- a drawer with that person's audit entries.

## Not built

- **Push alerts.** E-mail or in-app notifications on a new flag would need deduplication state
  and a recipient policy. Flags are visible on the page; pushing them is a follow-up.
- **Learned baselines.** Thresholds are fixed constants, not per-person statistics. Module-16 §14
  places learned anomaly detection under "AI ops (future)".
- **Context search.** No search over audit `context`, as the audit read port already decides.
