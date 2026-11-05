# Admin walkthrough on the staging stack (Work 80)

How the owner verifies every admin page live, as Admin and as Super Admin, against the staging
verification baseline. Two parts: a scripted walk that makes every read and action through the
API, and a short click-through that confirms the portal shows the same thing.

Every command runs from the staging worktree (where `backend/.env.staging` lives) unless it says
otherwise. Nothing here asks for a secret on the command line: passwords and authenticator codes
are typed at hidden prompts.

## 1. Seed the baseline

```bash
docker compose -f compose.staging.yml --env-file backend/.env.staging --profile tools run --rm tools npm run staging:seed
```

Refuses outside the staging database. Idempotent: a second run reports everything as already
present. What it creates, and why, is listed in `backend/src/cli/staging-seed/fixtures.ts`.

## 2. Set the fixture passwords (owner)

```bash
docker compose -f compose.staging.yml --env-file backend/.env.staging --profile tools run --rm tools npm run staging:set-password
```

Run it twice: once for `admin@staging.pharmalink.test`, once for `finance@staging.pharmalink.test`.
Then sign in to the portal once as the Admin and enrol an authenticator app (the portal shows the
setup key). The Super Admin is the account created by the first-Super-Admin bootstrap.

## 3. Run the scripted walk, once per role

From `backend/` in a checkout of the same commit, with the stack up:

```bash
npm run staging:walk
```

Type the e-mail, password and current authenticator code. The walk reads every admin page and
takes every action against the fixtures of the signed-in role's round:

| Page | Actions |
|---|---|
| Accounts | detail, suspend, reinstate, assign and revoke `CUSTOMER_SUPPORT` on the walk-target customer |
| Verifications | approve and reject a pharmacy licence; approve FAYDA and DRIVER_DOCS; reject DOCTOR_LICENSE |
| Pharmacies | activate the round's licensed, not-yet-activated pharmacy |
| Catalogue review | submit a draft, approve, reject, return a rejected product to review |
| COD disputes | resolve the round's open dispute |
| Configuration | toggle `staging_walk_demo` on and off; publish a setting's value twice unchanged and roll back |

It prints one line per call and saves `staging-walk-admin.json` or `staging-walk-superAdmin.json`
in the current directory (no secrets; not committed). Run it once as Admin and once as Super Admin.
A one-shot action already taken by an earlier walk is reported as `FIXTURE_NOT_FOUND`; reseeding
does not undo decisions, so a repeat walk needs a fresh staging database.

## 4. Click through the portal

Open the portal (`http://localhost:5173`, started from `web/` with
`VITE_API_BASE_URL=http://127.0.0.1:3000 npx vite`) and, after the walk, check that each page
shows what the walk did:

- **Dashboard / Analytics:** loads; counts include the seeded pharmacies, orders and COD cash.
- **Accounts:** the walk-target customer (`+251910000101`) is `ACTIVE` with no extra role; its
  audit trail shows the suspension, reinstatement, assignment and revocation.
- **Verifications:** the decided requests are gone from the PENDING queue; the remaining pending
  ones (the other round's) open in the drawer with their document references.
- **Pharmacies:** the activated pharmacy is `ACTIVE` and eligible.
- **Orders / Inventory:** the seven `STG-SEED-*` orders are listed; an order drawer opens.
- **Catalogue review:** the summary counts moved; each product's history shows the decision.
- **Finance:** payments in every seeded status, two refunds, one settlement with its lines.
- **COD disputes:** the resolved dispute shows the note; the other round's is still open.
- **Configuration (Super Admin):** the flag is off again; the setting's history shows the two
  publications and the rollback.
- **Audit Logs:** every action above appears, attributed to the signed-in account.
