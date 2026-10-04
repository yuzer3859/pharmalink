import { Injectable } from '@nestjs/common';
import { DispenseRecord as PrismaDispenseRecord, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DispenseRecordSnapshot,
  IDispenseLedgerRepository,
  NewDispenseRecordData,
} from '../../domain/repositories/dispense-ledger.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toDomain(row: PrismaDispenseRecord): DispenseRecordSnapshot {
  return {
    id: row.id,
    prescriptionLineId: row.prescriptionLineId,
    idempotencyKey: row.idempotencyKey,
    orderId: row.orderId,
    pharmacyId: row.pharmacyId,
    quantity: row.quantity,
    dispensedByUserId: row.dispensedByUserId,
    stockMovementId: row.stockMovementId,
    createdAt: row.createdAt,
  };
}

/**
 * Prisma adapter for `IDispenseLedgerRepository` (module-05 §3.4/§6.3/§8.1, §11) — persists the
 * append-only `dispense_records` ledger. `findByIdempotencyKey` looks up the exact
 * `(prescriptionLineId, idempotencyKey)` pair via the DB-generated compound unique index backing
 * `@@unique([prescriptionLineId, idempotencyKey])`, letting the future `DispenseMedicineCommand`
 * distinguish a first-time key (`null`) from a replay (existing row). `create` performs a plain
 * insert and does not catch a unique-constraint violation — a genuine conflict (a different
 * caller reusing the same key for a different logical dispense) is left to surface as the raw
 * Prisma `P2002` error so the command layer decides how to translate it; this repository does not
 * convert it into a fake successful replay (§6.3, task boundary).
 */
@Injectable()
export class PrismaDispenseLedgerRepository implements IDispenseLedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findByIdempotencyKey(
    prescriptionLineId: string,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<DispenseRecordSnapshot | null> {
    const row = await this.client(tx).dispenseRecord.findUnique({
      where: {
        prescriptionLineId_idempotencyKey: { prescriptionLineId, idempotencyKey },
      },
    });
    return row ? toDomain(row) : null;
  }

  async create(data: NewDispenseRecordData, tx?: unknown): Promise<DispenseRecordSnapshot> {
    const row = await this.client(tx).dispenseRecord.create({
      data: {
        prescriptionLineId: data.prescriptionLineId,
        idempotencyKey: data.idempotencyKey,
        orderId: data.orderId,
        pharmacyId: data.pharmacyId,
        quantity: data.quantity,
        dispensedByUserId: data.dispensedByUserId,
        stockMovementId: data.stockMovementId ?? null,
      },
    });
    return toDomain(row);
  }
}
