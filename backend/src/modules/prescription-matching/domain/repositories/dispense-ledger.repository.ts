export const DISPENSE_LEDGER_REPOSITORY = Symbol('DISPENSE_LEDGER_REPOSITORY');

/** One immutable `DispenseRecord` ledger row (module-05 §3.4). */
export interface DispenseRecordSnapshot {
  id: string;
  prescriptionLineId: string;
  idempotencyKey: string;
  orderId: string;
  pharmacyId: string;
  quantity: number;
  dispensedByUserId: string;
  stockMovementId: string | null;
  createdAt: Date;
}

/** Data required to append one dispense (§5.4, §12). */
export interface NewDispenseRecordData {
  prescriptionLineId: string;
  idempotencyKey: string;
  orderId: string;
  pharmacyId: string;
  quantity: number;
  dispensedByUserId: string;
  stockMovementId?: string | null;
}

/**
 * Persistence port for the append-only `dispense_records` ledger (module-05 §3.4, §6.3, §8.1) —
 * identical "no update/delete path is ever exposed" discipline as Module 04's `StockMovement`
 * (ADR-006).
 *
 * `findByIdempotencyKey` backs `DispenseMedicineCommand`'s replay check (§6.3, §8.1 step 3):
 * inside the same `Serializable` transaction as the prospective insert, looking up the exact
 * `(prescriptionLineId, idempotencyKey)` pair distinguishes a first-time key (`null` — proceed
 * with policy checks and the insert) from a replay (existing row — return its id unchanged,
 * re-check nothing, per `00-shared-conventions.md` §7's replay contract) from a **genuine**
 * conflict (a *different* caller reusing the same key for a different logical dispense, which
 * `create`'s DB-level `@@unique([prescriptionLineId, idempotencyKey])` constraint — the
 * authoritative, concurrency-safe guard this pre-check can never race ahead of — will reject).
 * This pre-check exists only to return the friendly replay result for the common case without
 * relying on catching the constraint violation as control flow.
 */
export interface IDispenseLedgerRepository {
  findByIdempotencyKey(
    prescriptionLineId: string,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<DispenseRecordSnapshot | null>;
  create(data: NewDispenseRecordData, tx?: unknown): Promise<DispenseRecordSnapshot>;
}
