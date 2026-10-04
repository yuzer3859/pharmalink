import { Injectable } from '@nestjs/common';
import { Prisma, ProofOfDelivery as PrismaProofOfDelivery } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { ProofOfDeliveryProps } from '../../domain/entities/proof-of-delivery.entity';
import { IProofOfDeliveryRepository } from '../../domain/repositories/proof-of-delivery.repository';

type Client = PrismaService | Prisma.TransactionClient;

/** Postgres' unique-violation code, surfaced by Prisma as `P2002`. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Prisma adapter for `IProofOfDeliveryRepository` (§8's `proof_of_delivery`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses the port (ADR-002).
 *
 * Like the port it implements, it offers **no update and no delete**. A `PrismaClient` can of
 * course do both, and the discipline is that nothing in this file calls them: the evidence a
 * dispute is settled against must not be rewritable through the module that collected it.
 */
@Injectable()
export class PrismaProofOfDeliveryRepository implements IProofOfDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  /**
   * Inserts, or returns `null` when this delivery already has proof.
   *
   * The unique index on `jobId` is the real guarantee, and catching its violation rather than
   * checking first is what makes two concurrent submissions safe: a read-then-insert has a window
   * between the two in which both callers see nothing and both proceed, and only the database can
   * close it. A caller that lost re-reads and decides whether the winner carries the same evidence.
   *
   * Only `P2002` is swallowed. Any other failure — a broken connection, a constraint this code did
   * not anticipate — propagates, because "the proof was not stored" must never be reported as
   * "the delivery already had proof".
   */
  async insert(
    proof: ProofOfDeliveryProps,
    tx?: unknown,
  ): Promise<ProofOfDeliveryProps | null> {
    try {
      const row = await this.client(tx).proofOfDelivery.create({
        data: {
          id: proof.id,
          jobId: proof.jobId,
          orderId: proof.orderId,
          fulfillmentId: proof.fulfillmentId,
          type: proof.type,
          recipientName: proof.recipientName,
          recipientConfirmed: proof.recipientConfirmed,
          capturedByDriverId: proof.capturedByDriverId,
          artifactRef: proof.artifactRef,
          artifactContentType: proof.artifactContentType,
          artifactBytes: proof.artifactBytes,
          artifactSha256: proof.artifactSha256,
          capturedAt: proof.capturedAt,
        },
      });
      return toProps(row);
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        return null;
      }
      throw err;
    }
  }

  async findByJobId(jobId: string, tx?: unknown): Promise<ProofOfDeliveryProps | null> {
    const row = await this.client(tx).proofOfDelivery.findUnique({ where: { jobId } });
    return row ? toProps(row) : null;
  }
}

function toProps(row: PrismaProofOfDelivery): ProofOfDeliveryProps {
  return {
    id: row.id,
    jobId: row.jobId,
    orderId: row.orderId,
    fulfillmentId: row.fulfillmentId,
    type: row.type,
    recipientName: row.recipientName,
    recipientConfirmed: row.recipientConfirmed,
    capturedByDriverId: row.capturedByDriverId,
    artifactRef: row.artifactRef,
    artifactContentType: row.artifactContentType,
    artifactBytes: row.artifactBytes,
    artifactSha256: row.artifactSha256,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
  };
}
