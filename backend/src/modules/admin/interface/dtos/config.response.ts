import {
  ConfigHistoryView,
  EffectiveConfigView,
} from '../../application/queries/get-config.query';
import { FeatureFlagView } from '../../application/queries/get-feature-flags.query';
import { PlatformConfigProps } from '../../domain/entities/platform-config.entity';
import { UpdateConfigResult } from '../../application/commands/update-config.command';
import { ToggleFeatureFlagResult } from '../../application/commands/toggle-feature-flag.command';

/**
 * One governable setting as the admin API reports it.
 *
 * An explicit allow-list, like every response in this repository. What is deliberately absent:
 *
 *  - **The row's `id`.** A configuration version is addressed by `namespace`, `key` and `version`,
 *    which is what every route takes. A uuid would be an identifier a client could store and then
 *    have no route to use.
 *  - **Any key outside the catalogue.** Not a filtering decision made here — the query is built
 *    from the catalogue, so a secret has no path to this shape in the first place.
 */
export interface ConfigResponse {
  namespace: string;
  key: string;
  valueType: string;
  description: string;
  /** The owning module's declared bounds, so a UI can validate before a round trip. */
  min: number | null;
  max: number | null;
  allowed: readonly string[] | null;
  /** The value in force right now. */
  effectiveValue: unknown;
  /** `ADMIN` when an administrator published it, `ENVIRONMENT` when it is the deployed default. */
  source: string;
  activeVersion: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** One historical version. The value is included — this is the history read. */
export interface ConfigVersionResponse {
  namespace: string;
  key: string;
  version: number;
  valueType: string;
  value: unknown;
  isActive: boolean;
  reason: string | null;
  updatedBy: string;
  createdAt: string;
}

export interface ConfigHistoryResponse {
  namespace: string;
  key: string;
  versions: ConfigVersionResponse[];
}

/** What a publish returns: the new state, and the version it replaced. */
export interface UpdateConfigResponse {
  config: ConfigVersionResponse;
  previous: ConfigVersionResponse | null;
}

export interface FeatureFlagResponse {
  key: string;
  enabled: boolean;
  description: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface ToggleFeatureFlagResponse {
  flag: FeatureFlagResponse;
  /** `true` when this call created the flag rather than moving an existing one. */
  created: boolean;
  /** `false` when the flag was already in the requested state and nothing was written. */
  changed: boolean;
}

export function toConfigResponse(view: EffectiveConfigView): ConfigResponse {
  return {
    namespace: view.namespace,
    key: view.key,
    valueType: view.type,
    description: view.description,
    min: view.min,
    max: view.max,
    allowed: view.allowed,
    effectiveValue: view.effectiveValue,
    source: view.source,
    activeVersion: view.activeVersion,
    updatedBy: view.updatedBy,
    updatedAt: view.updatedAt ? view.updatedAt.toISOString() : null,
  };
}

export function toConfigVersionResponse(props: PlatformConfigProps): ConfigVersionResponse {
  return {
    namespace: props.namespace,
    key: props.key,
    version: props.version,
    valueType: props.valueType,
    value: props.value,
    isActive: props.isActive,
    reason: props.reason,
    updatedBy: props.updatedBy,
    createdAt: props.createdAt.toISOString(),
  };
}

export function toConfigHistoryResponse(view: ConfigHistoryView): ConfigHistoryResponse {
  return {
    namespace: view.namespace,
    key: view.key,
    versions: view.versions.map(toConfigVersionResponse),
  };
}

export function toUpdateConfigResponse(result: UpdateConfigResult): UpdateConfigResponse {
  return {
    config: toConfigVersionResponse(result.config),
    previous: result.previous ? toConfigVersionResponse(result.previous) : null,
  };
}

export function toFeatureFlagResponse(view: FeatureFlagView): FeatureFlagResponse {
  return {
    key: view.key,
    enabled: view.enabled,
    description: view.description,
    updatedBy: view.updatedBy,
    updatedAt: view.updatedAt.toISOString(),
  };
}

export function toToggleFeatureFlagResponse(
  result: ToggleFeatureFlagResult,
): ToggleFeatureFlagResponse {
  return {
    flag: {
      key: result.flag.key,
      enabled: result.flag.status === 'ENABLED',
      description: result.flag.description,
      updatedBy: result.flag.updatedByUserId,
      updatedAt: result.flag.updatedAt.toISOString(),
    },
    created: result.created,
    changed: result.changed,
  };
}
