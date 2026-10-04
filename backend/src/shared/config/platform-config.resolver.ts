import { Injectable } from '@nestjs/common';
import { AppConfigService } from './app-config.service';
import { ConfigOverrideRegistry } from './config-override.registry';
import { IConfigPort } from './config.port';

/** Where an effective configuration value came from. */
export type ConfigValueSource = 'ADMIN' | 'ENVIRONMENT';

/**
 * The **effective** implementation of `IConfigPort`: an administrator's published override where
 * one exists, and the environment everywhere else.
 *
 * ## What this changes for the twenty-four existing call sites: nothing
 *
 * `IConfigPort` keeps the interface it has had since Phase 0 — same three methods, same synchronous
 * signatures — and `CONFIG_PORT` now resolves to this instead of directly to `AppConfigService`.
 * No feature module imports anything new, and with no overrides published every lookup reaches
 * exactly the same `AppConfigService` call it reached before. The port's own doc comment anticipated
 * this arrangement: "Module 16 (Admin) will later provide a DB-backed implementation … that can
 * override defaults at runtime, without any feature module changing its code."
 *
 * ## The security property, stated plainly
 *
 * **Only a key the resolver can see in the override snapshot is served from it, and only catalogued
 * keys ever enter that snapshot.** This matters because `IConfigPort.get()` is not only used for
 * business tunables: `TelebirrConfig` reads `TELEBIRR_API_SECRET` and `TELEBIRR_WEBHOOK_SECRET`
 * through it, and `AppConfigService` behind it can reach `JWT_ACCESS_SECRET` and
 * `MASTER_ENCRYPTION_KEY`. A resolver that consulted the database for *any* key would turn an admin
 * HTTP route into a way to replace a payment provider's credential.
 *
 * Three things prevent that, and any one of them would be sufficient:
 *
 *  1. `ConfigKey.of` refuses to construct a key outside `ConfigCatalogue`, so no command can write
 *     a row for a secret.
 *  2. `ConfigOverrideLoader` builds the snapshot only from catalogued paths, so even a row inserted
 *     by hand into `platform_configs` would not be loaded.
 *  3. Secrets are flat `SCREAMING_SNAKE` names and the catalogue contains only dotted
 *     `namespace.key` paths, so the two namespaces do not overlap in the first place.
 *
 * ## Staleness is bounded, never permanent
 *
 * The snapshot is refreshed by `ConfigOverrideLoader` on a timer and immediately on the instance
 * that published a change. Another instance therefore serves a superseded value for at most one
 * refresh interval — bounded by construction, because the refresh reloads the whole snapshot from
 * Postgres rather than applying deltas. There is no cache-invalidation message that can be missed,
 * which is the failure mode §11 warns about, and no second Redis client is introduced.
 */
@Injectable()
export class PlatformConfigResolver implements IConfigPort {
  constructor(
    private readonly env: AppConfigService,
    private readonly overrides: ConfigOverrideRegistry,
  ) {}

  /**
   * An administrator's value if one is published for this exact path, otherwise the environment's.
   *
   * `has` rather than a truthiness check on the value: `false` and `0` are legitimate published
   * values — `delivery.feeBase` of `0` is the current default — and treating them as "no override"
   * would make exactly those settings impossible to govern.
   */
  get<T = string>(key: string): T | undefined {
    if (this.overrides.has(key)) {
      return this.overrides.lookup(key) as T;
    }
    return this.env.get<T>(key);
  }

  /**
   * As `get`, but throws when nothing is found anywhere.
   *
   * The override is checked first for the same reason, and `AppConfigService.getOrThrow` remains
   * the thing that decides what "missing" means — this resolver does not invent a second notion of
   * a required key.
   */
  getOrThrow<T = string>(key: string): T {
    if (this.overrides.has(key)) {
      return this.overrides.lookup(key) as T;
    }
    return this.env.getOrThrow<T>(key);
  }

  /**
   * A stored flag if one exists, otherwise the environment's `FEATURE_<KEY>` check.
   *
   * **This is §10's "safe when missing", and the fallback is the whole of it.** If a flag with no
   * row returned `false`, then merely deploying this module would switch off every capability the
   * platform gates on a flag — features that are working today, disabled by the arrival of a table
   * that has nothing to say about them. Falling through to the environment means an unconfigured
   * flag behaves precisely as it did before, and a flag becomes administered only once somebody
   * administers it.
   */
  isFeatureEnabled(flag: string): boolean {
    const stored = this.overrides.flag(flag);
    if (stored !== undefined) {
      return stored;
    }
    return this.env.isFeatureEnabled(flag);
  }

  /**
   * Where the effective value for a path comes from — the distinction §16 of the brief asks the
   * read surface to make. Not part of `IConfigPort`: a feature module has no business branching on
   * where its configuration came from, and only the admin read surface calls this.
   */
  sourceOf(path: string): ConfigValueSource {
    return this.overrides.has(path) ? 'ADMIN' : 'ENVIRONMENT';
  }
}
