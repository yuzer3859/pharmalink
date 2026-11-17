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
6. **The accepting pharmacy has `rxRequests.claimMinutes` to send its quote.** If it lets the request go (`release`) or doesn't quote in time (the sweeper):
   - the request is offered to the others again, and their `TAKEN` offers reopen;
   - the offer window is extended to a full window from now;
   - the customer is told (`RX_REQUEST_REOPENED`), and so are the pharmacies (`RX_REQUEST_AVAILABLE_AGAIN`);
   - that pharmacy cannot take it again.
7. **The quote** (Work 135, `POST /pharmacy/rx-requests/:id/quote`). The holding pharmacist lists the medicines it will give, from the stock of its branch nearest the customer.
   - **Pricing:** lines are priced exactly as checkout prices an order: the catalogue price, the delivery fee for that branch, and the platform fee. The customer agrees to the total they will pay.
   - **Date:** the pharmacist confirms the prescription's date. It is checked against the strictest limit among the quoted medicines' controlled schedules.
   - **Attestations:** the pharmacist confirms the prescription is legible and valid.
   - **Paper:** the pharmacist says whether the original paper is needed (`paperRequired`). It defaults to yes when a quoted medicine is a controlled substance. A `PROHIBITED` medicine is never quoted.
   - **Timing:** the customer is told (`RX_REQUEST_QUOTED`) and has `rxRequests.quoteResponseMinutes` to answer.
8. **Confirm** (`POST /rx-requests/:id/confirm`, `{ payment? }`). The quote becomes an order through checkout itself:
   - it is placed for the quoted lines at that pharmacy only, keyed by the request, so any retry finishes the same order;
   - the prescription is attached and approved on the order as the quoting pharmacist, whose quote was the review;
   - cash on delivery is then paid; a prepaid order is paid in the same call through the gateway;
   - `orders.paperRxRequired` carries the paper decision to delivery (Work 136);
   - a catalogue price change since the quote answers `PRICE_CHANGED`, and nothing is placed.
9. **Decline the quote** (`POST /rx-requests/:id/decline-quote`), or let it lapse (the sweeper). The request ends and the pharmacy is told.
10. **A pharmacy that can't fill it declines.** Once every offer is declined, or released, or lapsed, the request ends `NO_PHARMACY`.
11. **If nobody accepts within `rxRequests.offerMinutes`**, the request ends `EXPIRED`.
12. **The customer can cancel** while no quote has been sent.

The customer is notified at each change of state. The Amharic of the six new templates is a draft awaiting the owner's review.

## Prescription date

A prescription older than `prescriptions.maxAgeDays` (default 14, the proposed policy), or dated in the future, is refused with `422 PRESCRIPTION_TOO_OLD`. The date is counted in calendar days.

`prescriptions.maxAgeDaysBySchedule` sets a different limit per controlled schedule, for example `{ "SCHEDULE_2": 7 }`. It is applied to the medicines the pharmacy quotes, and the pharmacist confirms the date there.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `rxRequests.offerMinutes` | 30 | How long pharmacies have to accept |
| `rxRequests.claimMinutes` | 15 | How long the accepting pharmacy has to quote |
| `rxRequests.radiusMeters` | 10000 | How far a branch may be from the address |
| `rxRequests.quoteResponseMinutes` | 30 | How long the customer has to confirm the quote |
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
| `POST /pharmacy/rx-requests/:id/quote` | `prescription:verify` | `{ lines: [{ catalogProductId, quantity }], prescriptionIssueDate, paperRequired?, legibilityOk, validityOk, note? }`; the holding pharmacy, within its claim |
| `POST /rx-requests/:id/confirm` | `order:create:own` | `{ payment?: { method, token?, returnUrl? } }`; answers `{ request, orderId }` |
| `POST /rx-requests/:id/decline-quote` | `prescription:upload:own` | While `QUOTED` |

## Still to come

- **Work 136:** the driver's round trip for an original paper prescription.
- **Works 137–139:** the portal, customer app and driver app screens.
