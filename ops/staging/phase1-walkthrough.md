# Phase 1 live walk on staging (Work 103)

This is the roadmap's Phase 1 happy path, walked by a person on the staging stack. The same chain
also runs automatically in `backend/test/phase1/marketplace.e2e-spec.ts`. The path is:

> browse → add to cart → (Rx verify) → checkout → pay → assign driver → deliver → PoD → settle,
> plus a declined payment releasing the stock.

You play the customer in the customer app, and two finance officers in the operations portal. The
pharmacy and the driver are played by `npm run staging:actors`, because their apps are outside the
Phase 1 mission. Real money never moves: payments use the test gateway (Work 94) and payouts use
the mock payout rail.

## 0. Redeploy staging at `main`

Run these in the staging worktree (`.claude/worktrees/beautiful-moore-19cc3a`):

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

On its first start the backend builds the search index from the catalogue and the stock (Work 98).
To rebuild it by hand, run `$D run --rm tools npm run search:reindex`.

## 1. Run the customer app against staging

```sh
cd app
VITE_API_BASE_URL=http://127.0.0.1:3000 VITE_PAYMENTS_TEST_MODE=true npx vite --port 5173 --strictPort
```

Open `http://localhost:5173`. Port 5173 is an origin the staging backend accepts, so stop the
operations portal first if it is using that port. Run the portal for step 9 on port 5174, which
staging also accepts:

```sh
cd web
VITE_API_BASE_URL=http://127.0.0.1:3000 npx vite --port 5174 --strictPort
```

`VITE_PAYMENTS_TEST_MODE=true` shows a test-token field at checkout, which staging needs for step
6. Never set it in a production build.

## 2. Sign up as the customer

Your own Resend account address is already the staging **Super Admin**, and admin accounts need
MFA, so it cannot be the customer. Resend's test sender refuses every other address (HTTP 403,
shown as *E-mail delivery is not set up…*), so a new customer never gets the sign-up code.

1. Register with an address of yours that is not a staging account, for example the Gmail alias
   `you+customer@gmail.com`. The app reports that no code was sent; that is expected.
2. Mark that customer's e-mail verified (Work 105). This only works on a new CUSTOMER account
   still waiting for verification, and it is audited:
   ```sh
   $D run --rm tools npm run staging:actors -- verify-customer <that e-mail>
   ```
3. Sign in with that e-mail and your password.

Once a domain is verified in Resend and set as the staging sender, every address receives its code
and step 2 is unnecessary.

## 3. Browse and add to the cart

1. Search for `ORS`. **Seed ORS oral rehydration sachet** shows *1 pharmacy · from ETB 12.00*.
   Tap **Near me** and allow your location to see the distance.
2. Open it and choose **Add to cart**.
3. Search for `Amoxicillin`. It is Rx, at *ETB 45.00*. Add it to the cart too.

## 4. Prescription

1. Go to **Prescriptions** and upload any PDF or photo. Its status is *Waiting for a pharmacist*.
2. At checkout the total shows, but **Place order** is disabled: *A prescription is needed…*.
3. Approve the prescription as the walk pharmacy's pharmacist:
   ```sh
   $D run --rm tools npm run staging:actors -- pharmacist <your e-mail>
   ```
4. Reload checkout. The block is gone, and on **Prescriptions** the status reads *Approved*.

## 5. Checkout and pay

Choose your address, or add one: a new address needs **Use my current location** (allow it in the browser), because delivery needs its map location. Then choose **Telebirr**. Leave the test token empty and choose **Pay
and place order**. You see *Order placed* and *Payment approved*. Note the order number
(`ORD-…`), then open **Follow your order**.

## 6. A declined payment releases the stock

Repeat steps 3–5 with a fresh cart, and type `test-decline` as the test token.

- The app says *Payment declined… Your order was cancelled and nothing was charged*.
- **Put the items back in my cart** restores the cart.
- Search still shows the same availability: the stock was released.

## 7. The pharmacy prepares the order

```sh
$D run --rm tools npm run staging:actors -- pharmacy ORD-…
```

The order page moves to *Ready for the driver*, then shows the delivery. The payment is captured
at this point (Work 96).

## 8. The driver delivers it

```sh
$D run --rm tools npm run staging:actors -- driver ORD-…
```

The tool puts a walk driver on shift, online and at the pharmacy, has the job offered to them and
accepts it at once (offers live 30 seconds), then delivers and takes the driver offline again.
Dispatch never re-offers a job to a driver whose offer on it expired, so the seed keeps a spare
walk driver (`+251910000108`) that the tool uses in that case (Work 105).

Keep the order page open:
- The **Delivery** card goes from *Driver assigned* through *On the way to you* to *Delivered*,
  live over the tracking connection.
- **Proof of delivery** then shows *Received by Staging customer*.
- The order reads *Delivered*.

## 9. Settle the pharmacy

Settlement covers the **prepaid** order. A COD order is payable only once its cash is remitted to
PharmaLink (the owner's COD decision, Work 97), which the walk tools do not do.

1. Both finance accounts need a password. The seed creates them without one. Set each in an
   interactive terminal; you type the password, hidden:
   ```sh
   $D run --rm tools npm run staging:set-password
   ```
   The first sign-in of each account enrols its own authenticator.
2. The portal has no "run statement" action, and the automatic run (Work 97) waits for an amount
   or a period the walk never reaches. Make the walk pharmacy's statement as the automatic run
   would (Work 105):
   ```sh
   $D run --rm tools npm run staging:actors -- statement now
   ```
   It is a *Draft* for **Seed Bole Pharmacy** with your prepaid order's line.
3. In the portal (`http://localhost:5174`), sign in as **finance@**. Under **Finance →
   Settlements**, open that statement and approve it for payment. (The other draft statement is a
   seed fixture for the admin walk; leave it.)
4. The pharmacy has no payout destination yet. As **finance@**, choose **Register destination**:
   a bank transfer with made-up details (bank code `TESTBANK`, account `1000000000001`, name
   `Seed Bole Pharmacy`). The mock payout rail moves no money.
5. As **finance.checker@**, **Verify** the destination. A pharmacy's first destination is payable
   at once; only a changed one waits.
6. As **finance@**, **Pay out**. The statement reads *PAID*, and the order's payment `SETTLED`.
7. **Finance → Reconciliation** reads *CLEAN*.

Each sign-in needs your password and authenticator code; you type them yourself.

## Record the result

In `architecture/phase-1-status.md`, under "Live walk", note the date, the order numbers, and any
step that did not behave as written.
