import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { PrescriptionStatus } from '../../domain/enums';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import { medicineDispensedEvent } from '../../domain/events';
import {
  DISPENSE_LEDGER_REPOSITORY,
  IDispenseLedgerRepository,
} from '../../domain/repositories/dispense-ledger.repository';
import {
  IPrescriptionRepository,
  PRESCRIPTION_REPOSITORY,
} from '../../domain/repositories/prescription.repository';
import { DispensingPolicy } from '../../domain/services/dispensing-policy';
import { PrescriptionStatusPolicy } from '../../domain/services/prescription-status-policy';
import { RemainingDispensable } from '../../domain/value-objects/remaining-dispensable';
import {
  DispenseMedicineInput,
  DispenseMedicineResult,
  IDispensingPort,
} from '../ports/inbound/dispensing.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithMatchRetry } from '../support/match-retry';

function isUniqueConstraintViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002');
}

/**
 * Implements `IDispensingPort` (module-05 §8.1, §10.4, §12 "Dispense medicine") — the
 * safety-critical anti-reuse ledger write (BRULE-12). Single `Serializable` transaction, bounded
 * retry (`runWithMatchRetry`, §2.1.1):
 *  1. Read the current `PrescriptionLine` (and its parent `Prescription`, for `expiryDate`)
 *     fresh, inside the transaction.
 *  2. Idempotency check (§6.3): an existing `(prescriptionLineId, idempotencyKey)` row is a
 *     **replay** — return its id unchanged, re-check nothing else (§8.1 step 3's literal
 *     instruction; Module 05, unlike Module 04's `ReserveStockCommand`, defines no
 *     payload-mismatch `IDEMPOTENCY_CONFLICT` case for dispense).
 *  3. `DispensingPolicy.assertCanDispense()` — expiry checked before exhaustion (§3.11
 *     invariant 4).
 *  4. Insert the `DispenseRecord`, recompute `dispensedQuantity`/`remainingDispensable`
 *     (`RemainingDispensable.compute`, never independently mutated, ADR-006).
 *  5. Cascade `Prescription.status -> CONSUMED` if the line is now exhausted and single-use
 *     (§8.1 step 7, §6.2).
 *  6. Audit `MEDICINE_DISPENSED`, outbox `MedicineDispensed`.
 * A concurrent insert racing the same `(prescriptionLineId, idempotencyKey)` pair is resolved by
 * catching the DB's `P2002` and re-reading the now-committed winning row as a replay — the
 * unique constraint, not this pre-check, is the actual concurrency-safety mechanism (§6.3).
 */
@Injectable()
export class DispenseMedicineCommand implements IDispensingPort {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    @Inject(DISPENSE_LEDGER_REPOSITORY) private readonly ledger: IDispenseLedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async dispense(input: DispenseMedicineInput): Promise<DispenseMedicineResult> {
    try {
      return await runWithMatchRetry(this.uow, async (tx) => this.attempt(input, tx));
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        // Lost the race on the (prescriptionLineId, idempotencyKey) unique constraint — a
        // concurrent dispense with the same key committed first. Re-read the winning,
        // now-committed row and resolve it as the replay it is (§6.3).
        const winner = await this.ledger.findByIdempotencyKey(
          input.prescriptionLineId,
          input.idempotencyKey,
        );
        if (winner) {
          return { dispenseRecordId: winner.id };
        }
      }
      throw err;
    }
  }

  private async attempt(
    input: DispenseMedicineInput,
    tx: unknown,
  ): Promise<DispenseMedicineResult> {
    const line = await this.prescriptions.findLineById(input.prescriptionLineId, tx);
    if (!line) {
      throw PrescriptionMatchingErrors.notFound('Prescription line not found');
    }

    const existing = await this.ledger.findByIdempotencyKey(
      input.prescriptionLineId,
      input.idempotencyKey,
      tx,
    );
    if (existing) {
      return { dispenseRecordId: existing.id };
    }

    const prescription = await this.prescriptions.findById(line.prescriptionId, tx);
    if (!prescription) {
      throw PrescriptionMatchingErrors.notFound();
    }

    DispensingPolicy.assertCanDispense(
      { remainingDispensable: line.remainingDispensable, expiryDate: prescription.expiryDate },
      input.quantity,
    );

    const record = await this.ledger.create(
      {
        prescriptionLineId: line.id,
        idempotencyKey: input.idempotencyKey,
        orderId: input.orderId,
        pharmacyId: input.pharmacyId,
        quantity: input.quantity,
        dispensedByUserId: input.dispensedByUserId,
        stockMovementId: input.stockMovementId ?? null,
      },
      tx,
    );

    const dispensedQuantity = line.dispensedQuantity + input.quantity;
    const remaining = RemainingDispensable.compute(line.prescribedQuantity ?? 0, dispensedQuantity);
    await this.prescriptions.updateLineDispenseState(line.id, dispensedQuantity, remaining.value, tx);

    if (remaining.isExhausted() && line.isSingleUse) {
      if (PrescriptionStatusPolicy.isLegalTransition(prescription.status, PrescriptionStatus.CONSUMED)) {
        await this.prescriptions.updateStatus(
          prescription.id,
          { status: PrescriptionStatus.CONSUMED },
          tx,
        );
      }
    }

    await this.audit.record(
      {
        actorUserId: input.dispensedByUserId,
        action: 'MEDICINE_DISPENSED',
        resourceType: 'PrescriptionLine',
        resourceId: line.id,
        context: { orderId: input.orderId, pharmacyId: input.pharmacyId, quantity: input.quantity },
      },
      tx,
    );

    await this.outbox.write(
      medicineDispensedEvent({
        prescriptionLineId: line.id,
        orderId: input.orderId,
        quantity: input.quantity,
      }),
      tx as never,
    );

    return { dispenseRecordId: record.id };
  }
}
