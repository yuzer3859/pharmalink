import { Inject, Injectable } from '@nestjs/common';
import {
  ConfigValueSource,
  PlatformConfigResolver,
} from '../../../../shared/config/platform-config.resolver';
import { ConfigValueType } from '../../domain/enums';
import { PlatformConfigProps } from '../../domain/entities/platform-config.entity';
import {
  IPlatformConfigRepository,
  PLATFORM_CONFIG_REPOSITORY,
} from '../../domain/repositories/platform-config.repository';
import { ConfigCatalogue, ConfigKeyDefinition } from '../../domain/services/config-catalogue';
import { ConfigKey } from '../../domain/value-objects/config-key.vo';

/** One governable setting, as an administrator sees it. */
export interface EffectiveConfigView {
  namespace: string;
  key: string;
  type: ConfigValueType;
  description: string;
  /** Inclusive bounds and permitted values, where the owning module declares them. */
  min: number | null;
  max: number | null;
  allowed: readonly string[] | null;
  /** The value actually in force right now. */
  effectiveValue: unknown;
  /** Whether that value came from an administrator's published version or from the environment. */
  source: ConfigValueSource;
  /** The active version, or `null` when the key has never been administered. */
  activeVersion: number | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface ConfigHistoryView {
  namespace: string;
  key: string;
  versions: PlatformConfigProps[];
}

/**
 * The configuration read surface (module-16 §9.4's `GET /admin/config`, §16 of the work brief).
 *
 * ## It reads the catalogue first, not the table
 *
 * A listing built from `platform_configs` would show only the settings somebody has already
 * changed — which is the least useful possible answer to "what can I configure?". An administrator
 * opening this page needs to see every governable key, most of which have never been touched, with
 * its current effective value and its permitted range.
 *
 * So the catalogue is the spine: every entry appears, and the stored version decorates it where one
 * exists. That also makes the security boundary visible in the product — the list *is* the set of
 * things that can be changed, and there is nothing else to discover.
 *
 * ## Effective value and its source are reported separately
 *
 * §16 asks for exactly this distinction, and it is not cosmetic. "The delivery fee is 0" means
 * something different when it is the environment default nobody has revisited than when an
 * administrator published it last Tuesday — the first is an absence of a decision, the second is a
 * decision. `source` is what tells them apart, and `activeVersion` is `null` in the first case.
 *
 * The effective value is read through `PlatformConfigResolver` rather than assembled here, so what
 * this surface reports is literally what a feature module would get from `IConfigPort` — the two
 * cannot disagree, because they are the same call.
 */
@Injectable()
export class GetConfigQuery {
  constructor(
    @Inject(PLATFORM_CONFIG_REPOSITORY)
    private readonly configs: IPlatformConfigRepository,
    private readonly resolver: PlatformConfigResolver,
  ) {}

  /** Every governable setting, optionally narrowed to one namespace. */
  async execute(namespace?: string): Promise<EffectiveConfigView[]> {
    const wanted = (namespace ?? '').trim();
    const definitions = wanted
      ? ConfigCatalogue.forNamespace(wanted)
      : ConfigCatalogue.all();

    // One query for every active override, then a map lookup per definition — rather than one
    // query per catalogued key, which would be 31 round trips to render a settings page.
    const active = await this.configs.findAllActive();
    const byPath = new Map(active.map((row) => [`${row.namespace}.${row.key}`, row]));

    return definitions.map((definition) => this.toView(definition, byPath));
  }

  /** One setting. `NOT_FOUND` when the key is not governable — see `ConfigKey.of`. */
  async byKey(namespace: string, key: string): Promise<EffectiveConfigView> {
    const configKey = ConfigKey.of(namespace, key);
    const active = await this.configs.findActive(configKey.namespace, configKey.key);
    const byPath = new Map(active ? [[configKey.path, active] as const] : []);
    return this.toView(configKey.definition, byPath);
  }

  /**
   * One key's full version history, newest first.
   *
   * The history is the point of the whole model, so it has a read of its own rather than being
   * buried in the single-key view: an auditor asking "what has this setting been?" wants the
   * sequence, not the current value with a version number attached.
   */
  async history(namespace: string, key: string): Promise<ConfigHistoryView> {
    const configKey = ConfigKey.of(namespace, key);
    return {
      namespace: configKey.namespace,
      key: configKey.key,
      versions: await this.configs.listVersions(configKey.namespace, configKey.key),
    };
  }

  private toView(
    definition: ConfigKeyDefinition,
    byPath: Map<string, PlatformConfigProps>,
  ): EffectiveConfigView {
    const path = `${definition.namespace}.${definition.key}`;
    const stored = byPath.get(path) ?? null;

    return {
      namespace: definition.namespace,
      key: definition.key,
      type: definition.type,
      description: definition.description,
      min: definition.min ?? null,
      max: definition.max ?? null,
      allowed: definition.allowed ?? null,
      // Through the resolver, so this is the same value a feature module would read.
      effectiveValue: this.resolver.get(path),
      source: this.resolver.sourceOf(path),
      activeVersion: stored?.version ?? null,
      updatedBy: stored?.updatedBy ?? null,
      updatedAt: stored?.createdAt ?? null,
    };
  }
}
