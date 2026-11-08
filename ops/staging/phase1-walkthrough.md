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

Open `http://localhost:5173`. Port 5173 is the origin the staging backend accepts, so stop the
operations portal first if it is using that port.

`VITE_PAYMENTS_TEST_MODE=true` shows a test-token field at checkout, which staging needs for step
6. Never set it in a production build.

## 2. Sign up as the customer

Register with **your own Resend account address**. While the test sender is in use, e-mail can
only go to that address. Then enter the code from the e-mail. You type the code yourself.

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

Choose your address (or add one), then **Telebirr**. Leave the test token empty and choose **Pay
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

Keep the order page open:
- The **Delivery** card goes from *Driver assigned* through *On the way to you* to *Delivered*,
  live over the tracking connection.
- **Proof of delivery** then shows *Received by Staging customer*.
- The order reads *Delivered*.

## 9. Settle the pharmacy

1. Sign in to the operations portal as **finance@** (Finance Officer).
2. Under **Finance → Settlements**, run a statement for **Seed Bole Pharmacy**, or wait for the
   automatic one (Work 97: by amount or by period). It includes your order's capture.
3. Ask to approve it, and approve it as **finance.checker@**. Do the same for the payout (Work 83).
   It reads *PAID*.
4. The order's payment now reads `SETTLED`.
5. **Finance → Reconciliation** reads *CLEAN*.

Each sign-in needs your password and authenticator code; you type them yourself.

## Record the result

In `architecture/phase-1-status.md`, under "Live walk", note the date, the order numbers, and any
step that did not behave as written.
