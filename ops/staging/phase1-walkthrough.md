# Phase 1 live walk on staging

This is the roadmap's Phase 1 happy path, walked by people on the staging stack. **Every role uses
its own app.** The same chain also runs automatically in `backend/test/phase1/marketplace.e2e-spec.ts`.

> browse → cart → checkout with the prescription → pharmacist reviews it on the order → pay →
> pharmacy prepares → driver delivers with
> proof → COD cash reaches PharmaLink → statement → maker-checker payout → `SETTLED`,
> plus a declined payment releasing the stock.

Real money never moves. Payments use the test gateway (Work 94), and payouts use the mock payout
rail. This version replaces the Work 103 walk, which used `staging:actors` for the pharmacy and the
driver. It was walked on 2026-11-12; the record is in `architecture/phase-1-status.md`.

| Role | App | Port | Account |
|---|---|---|---|
| Customer | Customer app (`app/`) | 5173 | your own e-mail (see step 2) |
| Pharmacist and pharmacy | Pharmacy portal (`web/`) | 5174 | `owner.bole@staging.pharmalink.test` |
| Driver | Driver app (`driver/`) | 5175 | `driver.walk@staging.pharmalink.test` |
| Finance maker and checker | Operations portal, Finance (`web/`) | 5174 | `finance@`, `finance.checker@` |

The backend's default CORS list allows all three ports.

## 0. Redeploy staging at `main`

In the staging worktree (`.claude/worktrees/beautiful-moore-19cc3a`):

```sh
git fetch origin && git checkout --detach origin/main
node ops/staging/ensure-env-secrets.mjs --check
D="docker compose -f compose.staging.yml --env-file backend/.env.staging --profile tools"
$D up -d --build --pull never        # backend (MinIO image from the local cache)
$D build tools                       # `up --build` does not rebuild the profiled tools image
$D run --rm tools npx prisma migrate deploy
$D restart backend                   # start the new code on the migrated database
$D run --rm tools npm run prisma:seed
$D run --rm tools npm run staging:seed
```

`ensure-env-secrets.mjs --check` must report `PASS`.

## 1. Passwords and apps

The seed creates sign-in accounts without passwords. Set each one you will use, in an interactive
terminal. You type the password, and it stays hidden:

```sh
$D run --rm tools npm run staging:set-password
```

Run it once per account: `owner.bole@`, `driver.walk@`, `finance@`, `finance.checker@`. Each finance
account enrols its own authenticator at its first sign-in.

Then start the three apps:

```sh
(cd app && npm ci && VITE_API_BASE_URL=http://127.0.0.1:3000 VITE_PAYMENTS_TEST_MODE=true npx vite --port 5173 --strictPort)
(cd web && npm ci && VITE_API_BASE_URL=http://127.0.0.1:3000 npx vite --port 5174 --strictPort)
(cd driver && npm ci && VITE_API_BASE_URL=http://127.0.0.1:3000 npx vite --port 5175 --strictPort)
```

`VITE_PAYMENTS_TEST_MODE=true` shows the test-token field at checkout. Never set it in a production
build.

## 2. Customer account

Your Resend account address is the staging Super Admin, so it can't be the customer. Resend's test
sender also refuses every other address, so a new customer never receives the sign-up code.

1. Register in the customer app with another address of yours, for example
   `you+customer@gmail.com`. The app says no code could be sent.
2. Mark that address verified. This is staging only and audited:
   `$D run --rm tools npm run staging:actors -- verify-customer <that e-mail>`.
3. Sign in.

Once a domain is verified in Resend and set as the staging sender, step 2 isn't needed.

## 3. Customer: cart and checkout with the prescription

The prescription travels with the order (owner decision 2026-11-16, Works 129, 132 and 133).

1. Search for `ORS` and add it. Search for `Amoxicillin`, which is Rx, and add it.
2. Open **checkout** and choose the address. A new address needs **Use my current location**.
3. The **Prescription** card asks for the prescription. Choose a PDF or photo; it reads
   *Prescription attached*.
4. Choose how to pay, then **Send to the pharmacist**. Nothing is charged yet.
   - **Prepaid order:** **Telebirr**. You pay after the approval (step 5).
   - **COD order:** **Cash on delivery**.

   The app reads *Sent to the pharmacist*. The order page and **My orders** show
   *With the pharmacist*. Each order carries its own prescription; an old approval is not reused.

## 4. Pharmacist: review on the order (pharmacy portal, `owner.bole@`)

On **Orders**, the order shows the customer's name and *To review* under Prescription. There is no
separate prescriptions page.
1. Open the order, then **Open the prescription**. The link is audited and short-lived.
2. Check it covers the items under *To prepare*, tick both attestations, and **Approve prescription**.
   **Reject** instead asks for a reason; the order is cancelled, its stock released, and the
   customer sees the reason on the order.

Accept and decline are not offered while the prescription waits for review.

## 5. Customer: pay

- **Prepaid order:** the order page reads *Prescription approved: pay now*. Choose **Telebirr**,
  leave the test token empty, then **Pay now**.
- **COD order:** nothing to do; the order goes straight to the pharmacy.

## 6. Declined payment

Fill a fresh cart and pay by Telebirr with the test token `test-decline`.

- The app says *Payment declined… nothing was charged*.
- **Put the items back in my cart** restores the cart.
- Search still shows the same stock.

## 7. Pharmacy: prepare (pharmacy portal, **Orders**)

Open the order, then **Accept**, **Start preparing** and **Ready for pickup**. For a prepaid order,
the payment is captured at this point (Work 96).

## 8. Driver: deliver (driver app, `driver.walk@`)

1. **Go online.** Allow location: dispatch needs it.
2. **Accept** the offer before its countdown ends.
3. On the job, step through *I am at the pharmacy*, *I have picked up the order*, *I am on my way*
   and *I have arrived at the customer*. The customer's order page follows the driver live.
4. **Record proof of delivery.**
   - For COD, record the cash, which defaults to the amount due.
   - Add the recipient's confirmation, or a signature or photo when the job requires one (Work 121).
   - Then **Complete delivery**.
5. **Cash collected** shows COD cash *with you*. **Earnings** shows the delivery.

## 9. Finance: cash, statement, payout (operations portal)

1. **finance@ → Finance → COD cash:** **Record cash received** for the COD order, with a receipt
   reference. The COD sale is now payable to the pharmacy, under the owner's COD rule.
2. **Finance → Settlements:** under *Owed since the last statement*, click **Run statement** for
   Seed Bole Pharmacy. It makes a draft.
3. Open the draft and ask for approval. **finance.checker@** approves it on **Approvals**.
4. The pharmacy needs a verified payout destination. finance@ registers it with **Register
   destination** (made-up details, for example bank code `TESTBANK`, account `1000000000001`), and
   finance.checker@ verifies it.
5. **Pay out.** finance.checker@ approves. The statement reads *PAID*, and each prepaid order's
   payment reads `SETTLED`.
6. **Finance → Reconciliation** reads *CLEAN*.

Every sign-in needs your password, and for finance your authenticator code. You type them
yourself.

## 10. Prescription request: send it to nearby pharmacies (Works 134–139)

This is the owner's ride-hailing style request (decision of 2026-11-17), alongside the cart checkout. Pharmacies within 10 km of the address, with a pharmacist, are offered it, and the first to accept owns it. `backend/docs/rx-requests.md` has the rules and settings.

1. **Customer** (app): Home → **Send a prescription**. Upload a PDF or photo, keep today's date, choose the address, and **Send to nearby pharmacies**. The page reads *Looking for a pharmacy* and how many pharmacies are considering it.
   - A date older than 14 days is refused.
2. **Pharmacist** (portal, `owner.bole@`): **Prescription requests** shows it within 10 seconds, with the customer's name. On any other portal page, a banner with **Open**, a count beside **Prescription requests** and a short chime announce it (Work 140). Open it, **Open the prescription**, then **Accept**.
   - A second pharmacist accepting the same request is told it's no longer available.
   - The customer's page reads *Seed Bole Pharmacy accepted it*.
3. **Quote:** add a medicine from the branch's stock with a quantity, confirm the date, choose **Required** under *Original paper prescription*, tick both attestations, then **Send the quote**.
4. **Customer:** the page shows the medicines, the total and *Keep the original paper prescription ready*. Choose **Cash on delivery**, then **Confirm and place order**. The order opens; it is paid, and the prescription is approved by the pharmacist.
5. **Pharmacy:** on **Orders**, **Accept** the order. Preparing isn't offered yet, because the paper comes first.
6. **Driver** (driver app, `driver.walk@`): accept the offer. A sound plays when the offer appears (Work 141). The job opens on a map of where to go: the customer first here, for the paper; **Directions in Google Maps** opens turn-by-turn navigation.
   - The job reads *Collect the paper prescription from the customer*. Press **I have the paper prescription**, then **I am at the pharmacy**.
   - It waits while the pharmacist checks the paper.
7. **Pharmacist:** in the order, choose **The paper matches: keep it**, then **Start preparing** and **Ready for pickup**.
   - **It does not match** with a reason cancels the order and its delivery instead.
8. **Driver:** **Check again**, then **I have picked up the order**, and deliver as in step 8.

Other paths to try:
- **Let it go:** after accepting, **We cannot fill it** offers the request to the other pharmacies again, and the customer is told.
- **Decline the quote:** the customer's **Decline** ends the request, and the pharmacy is told.
- **Time limits:** an unanswered request expires after 30 minutes; an unquoted acceptance reopens after 15.

## Record the result

In `architecture/phase-1-status.md`, note the date, the order numbers and any step that didn't
behave as written.

## Setup tools (not stand-ins)

`npm run staging:actors` still exists for setup and diagnosis:

| Command | What it does |
|---|---|
| `verify-customer` | Marks the walk customer verified (step 2) |
| `statement now` | Makes a statement the way the automatic run does |
| `reconciliation all` | Prints the reconciliation report |
| `pharmacist`, `pharmacy`, `driver` | Play those roles, kept for automated setup |

No step of the walk needs them for a role.
