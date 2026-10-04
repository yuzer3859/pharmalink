import { ProofOfDeliveryProps } from '../entities/proof-of-delivery.entity';

export const PROOF_OF_DELIVERY_REPOSITORY = Symbol('PROOF_OF_DELIVERY_REPOSITORY');

/**
 * Persistence for the `ProofOfDelivery` aggregate (§5.2, §8's `proof_of_delivery`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses this boundary (ADR-002).
 *
 * ## There is deliberately no `update` and no `delete`
 *
 * Not an oversight and not a gap to be filled by the next work that finds it inconvenient.
 * Delivery evidence is the artefact a dispute is resolved against, and a repository that could
 * rewrite it would make every guarantee above it advisory. The interface offers one write —
 * `insert`, which fails if the delivery already has proof — so "amend the evidence" is not an
 * operation this module can express.
 *
 * A correction, when the platform eventually needs one, is a new row under a version chain and a
 * workflow that decides who may supersede evidence and why. That work moves the unique index and
 * adds the methods it needs; until then the absence here is the guarantee.
 */
export interface IProofOfDeliveryRepository {
  /**
   * Writes the proof, or reports that the delivery already has one.
   *
   * Returns `null` on a unique-constraint collision rather than throwing, because the collision is
   * an expected outcome rather than an error: a handset retrying a submission it already made is
   * the ordinary case (§10), and two racing submissions are a case Postgres has to settle because
   * the application cannot. The caller reads the stored row and decides whether the retry carried
   * the same evidence — in which case it succeeded the first time — or different evidence, which
   * is an attempt to replace it.
   */
  insert(proof: ProofOfDeliveryProps, tx?: unknown): Promise<ProofOfDeliveryProps | null>;

  findByJobId(jobId: string, tx?: unknown): Promise<ProofOfDeliveryProps | null>;
}
