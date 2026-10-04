import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { ConfigOverrideRegistry } from '../../../../shared/config/config-override.registry';
import { FeatureFlagStatus } from '../../domain/enums';
import {
  FEATURE_FLAG_REPOSITORY,
  IFeatureFlagRepository,
} from '../../domain/repositories/feature-flag.repository';
import {
  IPlatformConfigRepository,
  PLATFORM_CONFIG_REPOSITORY,
} from '../../domain/repositories/platform-config.repository';
import { ConfigCatalogue } from '../../domain/services/config-catalogue';

/** The `SchedulerRegistry` key for the periodic refresh. */
export const CONFIG_REFRESH_CRON = 'admin.config-refresh';

/**
 * Keeps `ConfigOverrideRegistry` in step with `platform_configs` and `feature_flags`.
 *
 * ## The whole caching story, which is deliberately short
 *
 * Postgres is authoritative. This loader reads every active row and replaces the in-memory snapshot
 * wholesale — on boot, immediately after a publish on the instance that published it, and on a
 * timer for every other instance. There is no delta application, no invalidation message, and no
 * second Redis client, because §11 asks for a correct cache rather than a distributed configuration
 * system and this is the smallest thing that is correct.
 *
 * Replacing wholesale is what makes staleness *bounded*. A delta scheme has a failure mode where a
 * missed message leaves one key permanently wrong with nothing to detect it; a full reload cannot,
 * because the next tick overwrites whatever the previous one got wrong. §11's "stale cache must not
 * silently become permanent" is therefore a property of the refresh shape rather than a thing to
 * remember.
 *
 * ## Failure is survivable in the direction that matters
 *
 * A refresh that throws logs and **keeps the previous snapshot**. It does not clear it, because an
 * empty snapshot would silently revert every governed setting to its environment default — turning
 * a transient database blip into a platform-wide configuration change nobody ordered. Serving the
 * last known good values while the database is unreachable is both safer and closer to what the
 * operator asked for.
 *
 * Boot is the one exception, and it goes the other way: if the very first load fails, the snapshot
 * is already empty and the application still starts on environment defaults. That matches the
 * project's existing convention for Redis — degrade, do not refuse to boot.
 */
@Injectable()
export class ConfigOverrideLoader implements OnModuleInit {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(PLATFORM_CONFIG_REPOSITORY)
    private readonly configs: IPlatformConfigRepository,
    @Inject(FEATURE_FLAG_REPOSITORY) private readonly flags: IFeatureFlagRepository,
    private readonly registry: ConfigOverrideRegistry,
  ) {
    this.logger.setContext(ConfigOverrideLoader.name);
  }

  /** Loads once at startup so the first request already sees published overrides. */
  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /**
   * The periodic reload that bounds how long another instance can serve a superseded value.
   *
   * Every 30 seconds. Configuration changes are rare and deliberate — an operator publishing a fee
   * is not waiting on a sub-second propagation — while the cost of the query is two indexed reads
   * of a table with one row per governed setting.
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: CONFIG_REFRESH_CRON })
  async refresh(): Promise<void> {
    try {
      const [active, flags] = await Promise.all([
        this.configs.findAllActive(),
        this.flags.listAll(),
      ]);

      const values = new Map<string, unknown>();
      for (const row of active) {
        const path = `${row.namespace}.${row.key}`;
        // Catalogue-checked on the way *in* as well as on the way out. A row for a key the code no
        // longer reads — or one inserted by hand outside the command path — must not reach a
        // resolver that would then serve it in place of an environment value.
        if (ConfigCatalogue.isGovernable(path)) {
          values.set(path, row.value);
        }
      }

      const flagStates = new Map<string, boolean>();
      for (const flag of flags) {
        // `PARTIAL` is not enabled — see `FeatureFlag`. Nothing evaluates rollout rules in this
        // work, so a flag that claims partial rollout is reported off rather than guessed at.
        flagStates.set(flag.key.toLowerCase(), flag.status === FeatureFlagStatus.ENABLED);
      }

      this.registry.replace({ values, flags: flagStates, loadedAt: new Date() });
    } catch (err) {
      // Previous snapshot retained — see the class comment on why this must not clear.
      this.logger.error(
        `Failed to refresh platform configuration overrides: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
