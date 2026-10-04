import { FeatureFlagProps } from '../entities/feature-flag.entity';

export const FEATURE_FLAG_REPOSITORY = Symbol('FEATURE_FLAG_REPOSITORY');

/**
 * Persistence port for `FeatureFlag` (module-16 §8's `feature_flags`).
 *
 * Unlike `PlatformConfig`, a flag **is** updated in place, and the asymmetry is deliberate rather
 * than an inconsistency. A configuration value is a number the platform priced orders against and
 * whose history a finance question will ask about; a flag is a switch whose only history that
 * matters is "who turned it on, and when" — which the audit log already records in full, including
 * the previous state. Versioning a boolean would add a table's worth of rows to answer a question
 * the audit already answers.
 *
 * There is no delete: a capability that is no longer flagged is disabled, not forgotten.
 */
export interface IFeatureFlagRepository {
  findByKey(key: string, tx?: unknown): Promise<FeatureFlagProps | null>;

  /** Every flag, by key. Small by nature — this is the whole switchboard. */
  listAll(tx?: unknown): Promise<FeatureFlagProps[]>;

  /**
   * Inserts a flag, or reports that its key was taken.
   *
   * `null` on the unique collision rather than a throw, for the reason `insert` on the config
   * repository gives: two administrators enabling the same new flag at once is an expected race,
   * and the loser should end up looking at the winner's row rather than at an error. The re-read
   * happens outside the aborted transaction.
   */
  insert(flag: FeatureFlagProps, tx?: unknown): Promise<FeatureFlagProps | null>;

  /**
   * Moves a flag to a new state **only while it still holds the state the caller read**.
   *
   * A compare-and-set on `status`, returning `null` when the row has already moved. This is what
   * makes two simultaneous toggles resolve to one winner rather than letting a stale "disable"
   * overwrite an "enable" that landed a millisecond earlier — the same mechanism
   * `IJobOfferRepository.respond` uses, and for the same reason.
   */
  updateStatus(
    key: string,
    expected: FeatureFlagProps['status'],
    update: {
      status: FeatureFlagProps['status'];
      description: string | null;
      updatedByUserId: string;
      updatedAt: Date;
    },
    tx?: unknown,
  ): Promise<FeatureFlagProps | null>;
}
