import { PlatformConfigProps } from '../entities/platform-config.entity';

export const PLATFORM_CONFIG_REPOSITORY = Symbol('PLATFORM_CONFIG_REPOSITORY');

/**
 * Persistence port for `PlatformConfig` (module-16 §8's `platform_configs`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses this boundary (ADR-002).
 *
 * There is deliberately **no `update` and no `delete`**. A configuration version is a record of a
 * decision somebody took; the only state that ever changes is which version is currently in force,
 * and that is `deactivate`/`insert`, not an edit. A repository with an `updateValue` would make the
 * whole versioning scheme decorative, because the easiest way to change a setting would be to
 * overwrite one.
 */
export interface IPlatformConfigRepository {
  /**
   * The version currently in force for a key, or `null` when the key has never been configured.
   *
   * `null` is the normal case for most keys and is **not** an error: an unconfigured key means the
   * environment default is in force, which is what every key looked like before this module
   * existed.
   */
  findActive(namespace: string, key: string, tx?: unknown): Promise<PlatformConfigProps | null>;

  /**
   * Every active version across every governed key — the effective-override snapshot.
   *
   * One query rather than one per key, because this is what the resolver refreshes on a timer and
   * an N-query refresh would scale with the size of the catalogue rather than with the number of
   * settings anybody has actually overridden.
   */
  findAllActive(tx?: unknown): Promise<PlatformConfigProps[]>;

  /** One key's whole history, newest version first. */
  listVersions(namespace: string, key: string, tx?: unknown): Promise<PlatformConfigProps[]>;

  /** One specific version of one key, for rollback to read its value from. */
  findVersion(
    namespace: string,
    key: string,
    version: number,
    tx?: unknown,
  ): Promise<PlatformConfigProps | null>;

  /** The highest version number this key has reached, or `0` when it has never been configured. */
  maxVersion(namespace: string, key: string, tx?: unknown): Promise<number>;

  /**
   * Inserts a new version, or reports that its version number was taken.
   *
   * `null` on the unique-constraint collision rather than a throw, because the collision is an
   * expected outcome: two administrators who both read version 3 will both try to write version 4,
   * and exactly one of them must lose. The caller turns that into `CONFLICT` with an instruction to
   * re-read, rather than into a 500.
   *
   * **The re-read must not happen on this connection.** A unique violation aborts the enclosing
   * Postgres transaction, so any query issued afterwards on the same connection fails too — the
   * defect Module 08's COD work found against a real database. The caller unwinds first.
   */
  insert(config: PlatformConfigProps, tx?: unknown): Promise<PlatformConfigProps | null>;

  /**
   * Clears the active flag from whichever version currently holds it.
   *
   * Returns how many rows changed — `1` normally, `0` for a key being configured for the first
   * time. Called inside the publish transaction, immediately before the insert, so the partial
   * unique index never sees two active rows.
   */
  deactivateActive(namespace: string, key: string, tx?: unknown): Promise<number>;
}
