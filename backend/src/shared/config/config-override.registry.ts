import { Injectable } from '@nestjs/common';

/** One effective override, as the registry holds it. */
export interface ConfigOverrideSnapshot {
  /** Dotted path → the active value. Only governable keys ever appear. */
  values: ReadonlyMap<string, unknown>;
  /** Flag key (lower-case) → whether it is enabled. */
  flags: ReadonlyMap<string, boolean>;
  /** When this snapshot was built. */
  loadedAt: Date;
}

const EMPTY: ConfigOverrideSnapshot = {
  values: new Map(),
  flags: new Map(),
  loadedAt: new Date(0),
};

/**
 * The in-memory handover point between Module 16's stored configuration and every module that reads
 * `IConfigPort`.
 *
 * ## Why a registry, and why it lives in `shared`
 *
 * `IConfigPort.get()` is **synchronous** — it has been since Phase 0, and twenty-four call sites
 * across five modules depend on that. A database lookup is not synchronous, so "read the override
 * from Postgres on every get" is not an option that leaves the port's contract intact, and §6 of
 * the work brief is explicit that the existing port should be reused rather than replaced.
 *
 * A snapshot held in memory is what reconciles the two: Module 16 *pushes* the current effective
 * overrides here whenever they change and on a refresh timer, and `PlatformConfigResolver` reads
 * them synchronously. Postgres stays authoritative — this is a cache of it, never a second source
 * of truth, and it is rebuilt from the table rather than accumulated from events.
 *
 * It lives in `shared/config` rather than in the admin module because the *reader* is shared
 * infrastructure. If it lived in Module 16, `AppConfigModule` would have to depend on a feature
 * module to resolve a value, which inverts the layering. Module 16 depends on this; this depends on
 * nothing.
 *
 * ## Why it starts empty, and what that guarantees
 *
 * An empty registry means every `get()` falls through to the environment — which is **exactly** the
 * behaviour the platform had before this module existed. So the application boots correctly with no
 * `platform_configs` rows, with an unreachable database at the moment of first refresh, and with
 * Module 16 not loaded at all. §17's requirement that existing defaults not change is satisfied
 * structurally: a value changes only when an administrator has explicitly published one.
 */
@Injectable()
export class ConfigOverrideRegistry {
  private snapshot: ConfigOverrideSnapshot = EMPTY;

  /**
   * Replaces the whole snapshot.
   *
   * Wholesale rather than key-by-key, because a partial update cannot express a *removal* and
   * because rebuilding from a single query is what keeps the registry honest about being a cache of
   * the table rather than a log of the changes it has seen.
   */
  replace(snapshot: ConfigOverrideSnapshot): void {
    this.snapshot = snapshot;
  }

  /** The active override for a dotted path, or `undefined` when none is published. */
  lookup(path: string): unknown {
    return this.snapshot.values.get(path);
  }

  /** Whether a dotted path currently carries an override at all. */
  has(path: string): boolean {
    return this.snapshot.values.has(path);
  }

  /** The stored state of a flag, or `undefined` when no row exists for it. */
  flag(key: string): boolean | undefined {
    return this.snapshot.flags.get(key.toLowerCase());
  }

  /** The current snapshot, for diagnostics and for the effective-config read. */
  current(): ConfigOverrideSnapshot {
    return this.snapshot;
  }

  /** Drops every override. Used by tests, and by nothing else. */
  clear(): void {
    this.snapshot = EMPTY;
  }
}
