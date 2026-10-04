import { DriverEarningProps } from '../entities/driver-earning.entity';

export const DRIVER_EARNING_REPOSITORY = Symbol('DRIVER_EARNING_REPOSITORY');

/** One page of a driver's earnings ledger, newest first. */
export interface DriverEarningPage {
  items: DriverEarningProps[];
  total: number;
}

/** Paging for the driver's own ledger read. No filters that could widen the scope. */
export interface DriverEarningCriteria {
  driverId: string;
  limit: number;
  offset: number;
}

/**
 * Persistence for the `DriverEarning` aggregate (§5.1, §8's `driver_earnings`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses this boundary (ADR-002).
 *
 * ## There is deliberately no `update` and no `delete`
 *
 * §8 calls this table an "append-only ledger", and this interface is where that stops being a
 * description and becomes a property. The only write is `insert`, which fails if the job already
 * has an earning, so "change what a driver was paid" and "remove an earning" are operations this
 * module cannot express — not operations it merely declines to expose.
 *
 * That absence is the same guarantee `IProofOfDeliveryRepository` makes about evidence, and it
 * matters more here, not less: an earning is a statement about money owed to a person, and every
 * settlement figure Module 07 eventually produces is a sum of these rows. A repository that could
 * rewrite one would make every one of those figures provisional.
 *
 * **It also has no `markSettled`.** The `SETTLED` status exists in the enum and Delivery never
 * writes it: an earning becoming settled is a claim that money moved, and money is Module 07's
 * (§1). Adding the method here would be the first step in a delivery module asserting payments it
 * cannot make.
 *
 * A correction, when the platform needs one, is a new adjustment model under a workflow that
 * decides who may adjust a driver's pay and on what evidence. That work adds what it needs; until
 * then the absence here is the guarantee.
 */
export interface IDriverEarningRepository {
  /**
   * Writes the earning, or reports that the job already has one.
   *
   * Returns `null` on a unique-constraint collision rather than throwing, because the collision is
   * an expected outcome rather than an error: the outbox is at-least-once (ADR-010), so the
   * completion that triggers accrual will sometimes arrive twice, and two handlers can reach this
   * insert simultaneously. The caller reads the committed row and returns it, so both callers
   * converge on one earning.
   *
   * **The re-read must happen outside the transaction.** A unique violation aborts the enclosing
   * Postgres transaction, so a caller that catches the `null` and immediately queries on the same
   * connection will fail on the next statement — the defect the proof-of-delivery work found
   * against a real database and the reason this contract returns rather than throws.
   */
  insert(earning: DriverEarningProps, tx?: unknown): Promise<DriverEarningProps | null>;

  /** The earning for one delivery job, or `null`. The job id is the natural key. */
  findByJobId(jobId: string, tx?: unknown): Promise<DriverEarningProps | null>;

  /** One driver's ledger, newest first. Scoped by `driver_profiles.id`, never widened. */
  listByDriver(criteria: DriverEarningCriteria, tx?: unknown): Promise<DriverEarningPage>;
}
