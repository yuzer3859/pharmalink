import { IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION,
  DEFAULT_DELIVERY_COD_REQUIRE_EXACT_AMOUNT,
} from '../../../../shared/config/delivery.config';
import { CodPolicySettings } from '../../domain/services/cod-collection-policy';

/** Dotted config keys backing the two COD rules. */
export const COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY = 'delivery.codRequireExactAmount';
export const COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY =
  'delivery.codRequireCollectionForCompletion';

/**
 * Reads the configured COD rules (F-COD-01, §7, §16).
 *
 * A free function rather than an injectable, mirroring `resolvePodSettings`,
 * `resolveDeliveryFeeSettings` and `resolveDriverEarningSettings`: it is a projection of
 * configuration and holds nothing. Both callers that need it — the recording command and the
 * `COMPLETED` gate — get the same answer from the same place, which is what stops the requirement
 * being evaluated one way when cash is recorded and another way when the job is closed.
 *
 * Resolved on every call rather than cached, deliberately: an operator switching a rule on expects
 * the next delivery to obey it, not the next deployment. It is two map lookups.
 *
 * The values are read as booleans but tolerate the string form, because `IConfigPort` is an
 * interface with more than one implementation — `AppConfigService` hands over what
 * `deliveryConfig` parsed, while a test harness or Module 16's future DB-backed implementation may
 * hand over the raw operator string. Only a literal `true` enables a rule; everything else,
 * including an absent key, falls back to the documented default, which is `false` for both. An
 * unreadable COD policy must not silently start blocking deliveries.
 */
export function resolveCodSettings(config: IConfigPort): CodPolicySettings {
  return {
    requireExactAmount: readFlag(
      config,
      COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY,
      DEFAULT_DELIVERY_COD_REQUIRE_EXACT_AMOUNT,
    ),
    requireCollectionForCompletion: readFlag(
      config,
      COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY,
      DEFAULT_DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION,
    ),
  };
}

function readFlag(config: IConfigPort, key: string, fallback: boolean): boolean {
  const value = config.get<boolean | string>(key);
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }
  return fallback;
}
