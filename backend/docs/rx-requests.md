# Prescription requests (Work 134 onwards)

Owner decision of 2026-11-17: a customer who doesn't know what to pick sends a prescription, and nearby pharmacies compete to take it, like a ride-hailing request. This runs **alongside** the cart checkout with a prescription attached (Works 129–133); it does not replace it.

## Flow

1. **The customer uploads** the prescription (`POST /prescriptions/uploads`, then `POST /prescriptions`).
2. **The customer sends** it with a delivery address and the date on the prescription: `POST /rx-requests`.
3. **It is offered** to every eligible pharmacy near the address. Their owners and pharmacists are notified at once (`RX_REQUEST_NEW`). A pharmacy is eligible when:
   - its organisation is approved;
   - it is transacting, with a valid, unexpired licence;
   - it has at least one PHARMACIST;
   - one of its active branches is within `rxRequests.radiusMeters` of the address.

   If no pharmacy is eligible, the request ends `NO_PHARMACY` straight away.
4. **The pharmacies review it** (`GET /pharmacy/rx-requests`). They see the customer's name only, never contact details. A pharmacist opens the file through an audited, short-lived link (`POST /pharmacy/rx-requests/:id/file`).
5. **The first acceptance wins** (`POST /pharmacy/rx-requests/:id/accept`). It is a single conditional update on the request (`OPEN` to `CLAIMED`), so only one of two simultaneous accepts succeeds; the other gets `409 RX_REQUEST_UNAVAILABLE`.
   - The other pharmacies' offers become `TAKEN`, and they are told it is no longer available.
   - The customer is told which pharmacy accepted.
6. **The accepting pharmacy has `rxRequests.claimMinutes` to send its quote** (the quote is Work 135). If it lets the request go (`release`) or doesn't quote in time (the sweeper):
   - the request is offered to the others again, and their `TAKEN` offers reopen;
   - the offer window is extended to a full window from now;
   - the customer is told (`RX_REQUEST_REOPENED`), and so are the pharmacies (`RX_REQUEST_AVAILABLE_AGAIN`);
   - that pharmacy cannot take it again.
7. **A pharmacy that can't fill it declines.** Once every offer is declined, or released, or lapsed, the request ends `NO_PHARMACY`.
8. **If nobody accepts within `rxRequests.offerMinutes`**, the request ends `EXPIRED`.
9. **The customer can cancel** while no quote is agreed.

The customer is notified at each change of state. The Amharic of the six new templates is a draft awaiting the owner's review.

## Prescription date

A prescription older than `prescriptions.maxAgeDays` (default 14, the proposed policy), or dated in the future, is refused with `422 PRESCRIPTION_TOO_OLD`. The date is counted in calendar days.

`prescriptions.maxAgeDaysBySchedule` sets a different limit per controlled schedule, for example `{ "SCHEDULE_2": 7 }`. Work 135 applies it to the medicines the pharmacy quotes, and the pharmacist confirms the date there.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `rxRequests.offerMinutes` | 30 | How long pharmacies have to accept |
| `rxRequests.claimMinutes` | 15 | How long the accepting pharmacy has to quote |
| `rxRequests.radiusMeters` | 10000 | How far a branch may be from the address |
| `prescriptions.maxAgeDays` | 14 | The oldest prescription accepted |
| `prescriptions.maxAgeDaysBySchedule` | `{}` | A limit per controlled schedule |

## Routes

| Route | Permission | Notes |
|---|---|---|
| `POST /rx-requests` | `prescription:upload:own` | `{ prescriptionId, addressId, prescriptionIssueDate: 'YYYY-MM-DD', note? }` |
| `GET /rx-requests`, `GET /rx-requests/:id` | `prescription:read:own` | The customer's own requests only |
| `POST /rx-requests/:id/cancel` | `prescription:upload:own` | While `OPEN` or `CLAIMED` |
| `GET /pharmacy/rx-requests?scope=active\|all`, `GET /pharmacy/rx-requests/:id` | `order:fulfill:org` | Requests offered to the caller's pharmacies |
| `POST /pharmacy/rx-requests/:id/file` | `prescription:verify` | PHARMACIST of a pharmacy whose offer is open, or that holds the request |
| `POST /pharmacy/rx-requests/:id/accept` | `prescription:verify` | As above |
| `POST /pharmacy/rx-requests/:id/decline` | `prescription:verify` | `{ reason }`, 3–500 characters |
| `POST /pharmacy/rx-requests/:id/release` | `prescription:verify` | `{ reason? }`; the holding pharmacy only |

## Still to come

- **Work 135:** the pharmacy's quote (medicines from its stock, the paper-original flag, the date confirmed by the medicine's schedule), and the customer confirming it into an order.
- **Work 136:** the driver's round trip for an original paper prescription.
- **Works 137–139:** the portal, customer app and driver app screens.
