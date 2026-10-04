/**
 * Re-exported Prisma enums (`architecture/module-08-delivery-tracking.md` §5.2), the same pattern
 * as Modules 02/03/04/05/06/07's own `domain/enums.ts` — the domain layer depends on the enum
 * shape, not on `@prisma/client` as a whole.
 *
 * Only the enums this module actually uses are re-exported. `JobOfferStatus` joined the list with
 * the dispatch work, which is the first to have offers at all; `PodType` with the
 * proof-of-delivery work, which is the first to capture any; and `EarningStatus` with the driver
 * earnings work, which is the first to accrue one.
 *
 * `CodCollectionMethod` and `CodCollectionStatus` joined with the COD work, which is the first to
 * record a collection at all. The remittance work completes that lifecycle: all three
 * `CodCollectionStatus` values are now written, each by a different authority — `COLLECTED` by the
 * driver who took the money, `REMITTED` and `RECONCILED` by an authorized PharmaLink operator, and
 * never by the same permission. `CodReconciliationOutcome` arrives with it, and is the platform's
 * recorded finding rather than anybody's claim: it is computed from the amounts, and no caller can
 * supply it.
 *
 * `CodCorrectionType` and `CodDisputeStatus` join with the corrections work, which is the first to
 * need somewhere to put a mistake. Neither vocabulary contains a value that decides who absorbs a
 * shortfall — no `WRITE_OFF`, no `RECOVERY`, no `DRIVER_LIABLE` — because that decision has not
 * been taken anywhere in this repository, and an enum value is how it would get taken by accident.
 *
 * `EarningStatus` has two values and Delivery writes exactly one of them. `ACCRUED` is the record
 * that an amount was earned; `SETTLED` is the record that Module 07 has paid it, and nothing in
 * this module sets it — §1's boundary gives money movement to Module 07, and a delivery module
 * that could mark its own earnings settled would be asserting a payment it cannot make.
 */
export {
  CodCollectionMethod,
  CodCollectionStatus,
  CodCorrectionType,
  CodDisputeStatus,
  CodReconciliationOutcome,
  DeliveryJobStatus,
  DeliveryActorType,
  DriverAvailability,
  EarningStatus,
  JobOfferStatus,
  PodType,
} from '@prisma/client';
