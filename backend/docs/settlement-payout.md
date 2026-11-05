# Settlement approval and payout — Work 83

Module 07 §11.5 and §15 (Payout Execution — Readiness Review), ADR-022..026, with module-16's
maker-checker (Work 82, [maker-checker.md](maker-checker.md)). §15 left several items OPEN; the
owner asked for the recommended option on each, so each decision below is marked **(Work 83)** and
can be revisited.

## Lifecycle (ADR-023)

```
DRAFT ──approve──► APPROVED ──pay──► PROCESSING ──confirmed──► PAID
                                          ├──declined──────► FAILED ──pay again──► PROCESSING
                                          └──unknown───────► PROCESSING (refresh resolves it)
```

| Step | Ledger | Statement | Who |
| --- | --- | --- | --- |
| Generate (`POST /admin/finance/settlements/run`) | nothing | DRAFT | `finance:settlement:any` |
| Approve (`POST …/settlements/{id}/approve`) | nothing | APPROVED, `approvedByUserId`, `approvedAt` | maker and checker hold `finance:settlement:any` |
| Pay (`POST …/settlements/{id}/pay`) — attempt | nothing; the attempt row is committed before the call | PROCESSING | maker and checker hold `finance:payout:any` |
| Pay — confirmed (PAID / ALREADY_PAID) | `SETTLEMENT-<settlementId>`: DEBIT PROVIDER_PAYABLE, CREDIT GATEWAY_CLEARING, the stored `netPayable` | PAID, `paidAt`; `settlement.paid` event | |
| Pay — declined | nothing | FAILED (`PAYOUT_DECLINED`) | |
| Pay — undeterminable or the call threw | nothing | stays PROCESSING; attempt UNKNOWN | |
| Refresh (`POST …/settlements/{id}/payout/refresh`) | as confirmed / declined | | `finance:payout:any`, no maker-checker (it moves nothing by itself) |

Idempotency (ADR-024): the posting is keyed on the settlement (exactly once ever); the provider call
on the attempt (`PAYOUT-<attemptId>`); the attempt on the caller's key (`approval:<id>` through
maker-checker), so a resumed approval resolves its attempt instead of paying again. One open
(PENDING/UNKNOWN) attempt per settlement is a unique index.

## Decisions (Work 83)

1. **Maker-checker** (§15.3 OPEN): approve, pay and destination verification are maker-checker actions
   `SETTLEMENT_APPROVE`, `SETTLEMENT_PAYOUT`, `PAYOUT_BENEFICIARY_VERIFY`, and **on by default**
   (`approvals.makerCheckerActions` defaults to all three; `APPROVALS_MAKER_CHECKER_ACTIONS=none` or a
   published `[]` switches them off). The maker can never decide their own request, Super Admin
   included.
2. **Permissions** (§15.3): new `finance:payout:any` for paying and for destinations, granted to
   FINANCE_OFFICER only (SUPER_ADMIN by wildcard). ADMIN holds neither settlement permission.
3. **Payout destination** (§15.4 OPEN): Module 07 owns `payout_beneficiaries` (it owns the money; a
   Module 04 or 16 owner would add a cross-module write for no gain). Rails: `BANK_TRANSFER` (bank code
   + 6–34 character account) and `TELEBIRR` (Ethiopian mobile number, stored `+2519…`). The identifier
   is envelope-encrypted (ADR-009); only its last four characters are stored in clear, shown, or
   audited.
4. **Verification** (§15.4 OPEN): a destination starts PENDING_VERIFICATION and is verified by a
   *different* finance officer than the one who registered it — enforced in Module 07 itself, so no
   wildcard or switched-off maker-checker skips it. One pending and one verified destination per
   pharmacy (unique indexes).
5. **Change control** (§15.4 OPEN): verifying a replacement supersedes the old destination and starts a
   **24-hour cooling-off** (`payableFrom`); a pharmacy's first destination has none. Payout is refused
   (`PAYOUT_BENEFICIARY_REQUIRED`) with no verified destination or during cooling-off.
6. **Rail** (Open Question 4): no real payout rail is contracted. `PAYOUT_PROVIDER_PORT` is the
   `MockPayoutProvider` everywhere except `NODE_ENV=production`, where `UnavailablePayoutProvider`
   refuses every payout before anything is written. No money moves anywhere. Mock outcomes follow the
   account identifier: `…0000` declines, `…9999` is ambiguous until a refresh confirms it, anything
   else pays.
7. **Nothing to pay**: a statement whose `netPayable` is zero or negative is refused
   (`INVALID_SETTLEMENT_STATE_TRANSITION`); recovering money a pharmacy owes is a commercial decision
   still OPEN (§15.9).

## Not built (still OPEN in §15)

- Cancelling a DRAFT/APPROVED statement (§15.2).
- `Payment → SETTLED` for the payments a paid statement covers (§6). The posting consumes the payable,
  which is what reconciliation and later statements read; the payment status change is left for the
  work that resolves the PARTIALLY_REFUNDED question in §6.
- The §15.10 payout reconciliation anomaly kinds.
- Payout callbacks, partial payouts and returned transfers (§15.8) — they depend on a real rail.
- Revoking a destination without replacing it.

## Endpoints

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /admin/finance/settlements/{id}/payout` | `finance:settlement:any` | state, attempts (no idempotency keys), verified destination |
| `POST /admin/finance/settlements/{id}/approve` | `finance:settlement:any` | `Idempotency-Key`; 202 `MAKER_CHECKER_PENDING` or 200 `EXECUTED` |
| `POST /admin/finance/settlements/{id}/pay` | `finance:payout:any` | as above |
| `POST /admin/finance/settlements/{id}/payout/refresh` | `finance:payout:any` | resolves an open attempt |
| `GET /admin/finance/pharmacies/{pharmacyId}/payout-beneficiaries` | `finance:settlement:any` | masked |
| `POST /admin/finance/pharmacies/{pharmacyId}/payout-beneficiaries` | `finance:payout:any` | registers PENDING_VERIFICATION |
| `POST /admin/finance/payout-beneficiaries/{id}/verify` | `finance:payout:any` | `Idempotency-Key`; maker-checker |

Audit actions: `SETTLEMENT_APPROVED`, `PAYOUT_INITIATED`, `SETTLEMENT_PAID`, `PAYOUT_FAILED`,
`PAYOUT_BENEFICIARY_REGISTERED`, `PAYOUT_BENEFICIARY_VERIFIED`, plus Work 82's approval entries.
