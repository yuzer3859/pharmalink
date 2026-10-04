import { Inject, Injectable } from '@nestjs/common';
import { PrescriptionLineCandidate, PrescriptionGate, RxGateLine } from '../../domain/services/prescription-gate';
import { RxClassificationPolicy } from '../../domain/services/rx-classification-policy';
import {
  IPrescriptionRepository,
  PRESCRIPTION_REPOSITORY,
} from '../../domain/repositories/prescription.repository';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';
import {
  CheckRxGateInput,
  CheckRxGateResult,
  ICheckRxGatePort,
} from '../ports/inbound/check-rx-gate.port';

/** Large enough to fetch "every APPROVED prescription for this customer" in one page — the gate
 * needs the full set, not a paginated slice (no speculative new repository method is added; the
 * existing `listByCustomer` paging contract is reused at its ceiling instead, §11's "do not add
 * speculative repository methods"). */
const MAX_APPROVED_PRESCRIPTIONS = 1000;

/**
 * Implements `ICheckRxGatePort` (module-05 §5.3, §8.2, §10.4) — the Rx checkout gate consumed
 * in-process by Module 06 (future). Read-only, no transaction/lock (§8.2: "check-then-act is
 * advisory, the real lock is at the mutating step" — `DispenseMedicineCommand`). Fetches the
 * customer's `APPROVED` prescriptions' lines via `IPrescriptionRepository` and each requested
 * product's Rx classification via `ICatalogPort`, then delegates the actual allow/block decision
 * to the pure `PrescriptionGate` domain service — no gate logic lives here.
 */
@Injectable()
export class CheckRxGateCommand implements ICheckRxGatePort {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
  ) {}

  async check(input: CheckRxGateInput): Promise<CheckRxGateResult> {
    const rxGateLines: RxGateLine[] = await Promise.all(
      input.items.map(async (item) => {
        const product = await this.catalog.getProduct(item.catalogProductId);
        return {
          catalogProductId: item.catalogProductId,
          isRx: RxClassificationPolicy.requiresPrescription(product?.rxClassification),
          quantity: item.quantity,
        };
      }),
    );

    const { items: approvedPrescriptions } = await this.prescriptions.listByCustomer({
      customerUserId: input.customerUserId,
      status: 'APPROVED',
      page: 1,
      size: MAX_APPROVED_PRESCRIPTIONS,
    });

    const candidateLines: PrescriptionLineCandidate[] = [];
    for (const prescription of approvedPrescriptions) {
      const lines = await this.prescriptions.findLinesByPrescriptionId(prescription.id);
      for (const line of lines) {
        if (!line.catalogProductId) {
          continue;
        }
        candidateLines.push({
          prescriptionLineId: line.id,
          catalogProductId: line.catalogProductId,
          remainingDispensable: line.remainingDispensable,
          expiryDate: prescription.expiryDate,
        });
      }
    }

    return PrescriptionGate.check(rxGateLines, candidateLines);
  }
}
