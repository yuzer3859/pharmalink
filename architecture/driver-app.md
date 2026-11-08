# Driver app: design note (Work 106)

The driver's own app for Phase 1 (module-08 §9.1–9.2). It replaces `staging:actors -- driver` as
the driver in the live walk. This note fixes the screens, the APIs, auth, real time, proof of
delivery and offline behaviour before the build Works (115–119) start.

## Stack

`driver/` is a new mobile-first web app with the same stack and conventions as `app/`: React 18,
Vite, JavaScript (JSX), Tailwind, React Router, Vitest with React Testing Library, and
`socket.io-client` for tracking. It reuses `app/`'s patterns, copied rather than shared, because
neither app is a package:
- `apiClient`: envelope parsing, `ApiError`, request ids;
- `authService`: access token in memory, refresh token in `sessionStorage`, one refresh at a time;
- `AuthContext`.

A CI job, `.github/workflows/driver-ci.yml`, mirrors `app-ci.yml` (test and build).

No other stack was considered: the driver needs the same browser APIs as the customer app
(geolocation, camera through `<input capture>`), and keeping one style halves the review cost.

## Auth

- Drivers sign in with e-mail and password through `POST /auth/login`, like every other account.
  SMS is not available (`backend/.env.example`: codes go by e-mail).
- The app accepts an account only if it holds the `DRIVER` role and a driver profile. Anything
  else gets a clear "this account is not a driver account" message, never a generic error.
- Driver verification (BRULE-09) follows the existing identity flow: documents submitted and
  approved in the operations portal. The app shows *Waiting for verification* until then, and the
  backend refuses availability and offers anyway.
- On staging the walk drivers are seeded fixtures with an e-mail address. The owner sets their
  passwords with `staging:set-password`, which Work 114 extends to them.

## Screens

| Screen | What it does | APIs |
|---|---|---|
| Sign in | E-mail and password; staff or customer accounts are refused with a clear message | `POST /auth/login`, `GET /users/me` |
| Home / availability | Go online or offline; shows shift state, verification state and the active job, if any | `PUT /driver/availability`* (starts the shift when going online, ends it when going offline), `GET /driver/profile`* |
| Offer | The offered job: pickup branch, drop-off area, distance, fee, COD amount; **Accept** / **Decline** with a countdown to the offer's expiry | `GET /driver/jobs` (offered + active)*, `POST /delivery/jobs/:id/accept`, `POST /delivery/jobs/:id/decline` |
| Active job | Pickup, then drop-off, with addresses and a map link; one button per next status | `POST /delivery/jobs/:id/arrived-pickup` · `picked-up` · `en-route` · `arrived-dropoff`, `GET /delivery/jobs/:id/status` |
| Proof of delivery | What the job's PoD rule needs (`delivery.podRequirement`, `podCodRequirement`, `podColdChainRequirement`): recipient confirmation, signature or photo | `POST /delivery/jobs/:id/proof-of-delivery`, then `POST /delivery/jobs/:id/deliver` |
| COD | For a COD job: the amount to collect, recorded before delivery when the rule requires it; afterwards the collection's remittance state (*with the driver* → *remitted to PharmaLink*) | `POST`/`GET /delivery/jobs/:id/cod-collection` |
| Earnings | Earnings ledger and summary, per job | `GET /driver/earnings`, `GET /delivery/jobs/:id/earning` |
| History | Finished jobs | `GET /driver/jobs?status=…` |

`*` = a backend gap. These module-08 §9.1 routes do not exist yet; Work 114 adds them, each over
the existing command:
- `PUT /driver/availability` over `SetDriverAvailabilityCommand`, plus `ManageDriverShiftCommand`
  for the shift;
- `GET /driver/profile` over the driver profile repository;
- `POST /delivery/location` over `UpdateDriverLocationCommand`.

They are guarded by the driver permissions already in the RBAC catalogue (`delivery:read:own`,
`delivery:update:own`). Work 114 also confirms that `GET /driver/jobs` returns the driver's live
offer with its `expiresAt`; if it does not, the gap is fixed there.

## Remittance

**Remittance is recorded by finance, not the driver.** The driver hands the cash to PharmaLink.
Finance records it in the operations portal (`POST /admin/delivery/cod-reconciliation/:id/remit`,
already built), and the pharmacy is paid only after that (the owner's COD decision, Work 97). The
driver app shows the state; it never claims a remittance on the driver's word.

## Real time

- **Offers.** The app polls `GET /driver/jobs` every few seconds while online. An offer lives
  `delivery.offerTtlSeconds` (30 s by default), so polling every 5 s leaves the driver at least
  20 s to decide. The tracking socket carries customer-facing job updates, not offers. A push
  channel for offers is a later improvement, not needed for Phase 1.
- **Location.**
  - While online with no job: `POST /delivery/location` every 15 s. Work 114 adds a server-side throttle with the route. That
    keeps the driver eligible for dispatch, which needs a recent location near the pickup.
  - On a job: the tracking socket's `location` message for the job (`PublishJobLocationCommand`,
    already built, which the customer's order page follows live), plus `POST /delivery/location`
    for the profile.
  - Location comes from `navigator.geolocation.watchPosition`, only while the app is open and the
    driver is online. It is never stored on the device. On staging it stays on staging.
- **Status.** Every transition is a REST call. The app re-reads `GET /delivery/jobs/:id/status`
  after each call and when it regains focus.

## Proof of delivery

The backend decides what each job needs (BRULE-29/30), and the app asks for exactly that:
- **Confirmation:** the recipient's name, and a tick that they received it.
- **Signature:** a canvas signature, uploaded as a PNG.
- **Photo:** `<input type="file" accept="image/*" capture="environment">`.

Artifacts go to document storage through the existing PoD route (`doc:pod/<jobId>/<uuid>`,
Work 102). A refused PoD (`POD_REQUIRED`) shows the backend's reason.

## Offline behaviour

The driver app is online-first; Phase 1 does not queue actions offline.
- With no connection, every action button is disabled and a banner says *No connection*.
- Location samples taken offline are dropped, not replayed; a stale location must not move a job.
- The active job is re-read on reconnect, so a transition made elsewhere (a reassignment) wins.
- Status calls carry idempotency where the backend takes it, so a retried tap is safe.

## Out of scope for Phase 1

Native apps, background location while the app is closed, push notifications, navigation inside
the app, multi-job batching, and driver self-registration (drivers are provisioned and verified
through the operations portal).
