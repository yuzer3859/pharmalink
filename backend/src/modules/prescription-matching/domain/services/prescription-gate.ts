import { ErrorCode } from '../../../../shared/errors/error-codes';

export interface RxGateLine {
  catalogProductId: string;
  isRx: boolean;
  quantity: number;
}

/** An already owner-scoped, `APPROVED` candidate line (§3.11 invariant 5) available to the gate. */
export interface PrescriptionLineCandidate {
  prescriptionLineId: string;
  catalogProductId: string;
  remainingDispensable: number;
  /** Parent prescription's `expiryDate`, if any — `null` means "no stated expiry". */
  expiryDate: Date | null;
}

export interface BlockedItem {
  catalogProductId: string;
  reason: ErrorCode.RX_REQUIRED | ErrorCode.PRESCRIPTION_EXPIRED | ErrorCode.PRESCRIPTION_EXHAUSTED;
}

export interface RxGateResult {
  allowed: boolean;
  blocked: BlockedItem[];
  usablePrescriptionLineIds: string[];
}

/**
 * `PrescriptionGate` (module-05 §3.9, FR-MED-10, BRULE-10/11/12, §3.11 invariant 5). Pure
 * function over snapshots the (not-yet-built) application layer will have already fetched via
 * repositories/`ICatalogPort` and scoped to the ordering customer — this function performs no
 * I/O of its own. OTC lines (`isRx = false`) always pass. For each Rx line, at least one
 * `APPROVED`, non-expired candidate line for the *same* `catalogProductId` (substitute matching,
 * BRULE-16, is out of scope — §0.2) with `remainingDispensable >= quantity` must exist, else the
 * line is blocked with the most specific applicable reason:
 *  - `RX_REQUIRED` if no matching-product candidate line exists at all;
 *  - `PRESCRIPTION_EXPIRED` if a matching line exists but every one of them is expired;
 *  - `PRESCRIPTION_EXHAUSTED` if a matching, non-expired line exists but none has enough
 *    remaining quantity.
 */
export const PrescriptionGate = {
  check(
    lines: RxGateLine[],
    candidateLines: PrescriptionLineCandidate[],
    now: Date = new Date(),
  ): RxGateResult {
    const blocked: BlockedItem[] = [];
    const usablePrescriptionLineIds = new Set<string>();

    for (const line of lines) {
      if (!line.isRx) {
        continue;
      }

      const matches = candidateLines.filter((c) => c.catalogProductId === line.catalogProductId);
      if (matches.length === 0) {
        blocked.push({ catalogProductId: line.catalogProductId, reason: ErrorCode.RX_REQUIRED });
        continue;
      }

      const nonExpired = matches.filter(
        (c) => !c.expiryDate || c.expiryDate.getTime() > now.getTime(),
      );
      if (nonExpired.length === 0) {
        blocked.push({
          catalogProductId: line.catalogProductId,
          reason: ErrorCode.PRESCRIPTION_EXPIRED,
        });
        continue;
      }

      const usable = nonExpired.find((c) => c.remainingDispensable >= line.quantity);
      if (!usable) {
        blocked.push({
          catalogProductId: line.catalogProductId,
          reason: ErrorCode.PRESCRIPTION_EXHAUSTED,
        });
        continue;
      }

      usablePrescriptionLineIds.add(usable.prescriptionLineId);
    }

    return {
      allowed: blocked.length === 0,
      blocked,
      usablePrescriptionLineIds: [...usablePrescriptionLineIds],
    };
  },
};
