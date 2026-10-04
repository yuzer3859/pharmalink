import { IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_DELIVERY_POD_COD_REQUIREMENT,
  DEFAULT_DELIVERY_POD_COLD_CHAIN_REQUIREMENT,
  DEFAULT_DELIVERY_POD_REQUIREMENT,
  DELIVERY_POD_REQUIREMENTS,
} from '../../../../shared/config/delivery.config';
import {
  PodPolicySettings,
  PodRequirement,
} from '../../domain/services/proof-of-delivery-policy';

/** Dotted config keys backing the three policy rules. */
export const POD_REQUIREMENT_CONFIG_KEY = 'delivery.podRequirement';
export const POD_COLD_CHAIN_REQUIREMENT_CONFIG_KEY = 'delivery.podColdChainRequirement';
export const POD_COD_REQUIREMENT_CONFIG_KEY = 'delivery.podCodRequirement';

/**
 * Reads the configured proof-of-delivery rules (BR-DEL-06, BRULE-29).
 *
 * A free function rather than an injectable, because it is a projection of configuration and holds
 * nothing. Both callers that need it — the capture path's read model and the `DELIVERED`
 * transition's gate — get the same answer from the same place, which is what stops the requirement
 * being evaluated one way when evidence is captured and another way when delivery is attempted.
 *
 * `env.validation.ts` already rejects an unrecognised value at boot, so this fall-back only fires
 * when a key is absent entirely — a test harness with a bare config, say. It falls back to the
 * *defaults*, which are `NONE`: an unreadable policy must not silently become a strict one that
 * blocks every delivery on the platform, nor a strict one silently become lax. The defaults are
 * the documented position, and this returns exactly them.
 */
export function resolvePodSettings(config: IConfigPort): PodPolicySettings {
  return {
    base: read(config, POD_REQUIREMENT_CONFIG_KEY, DEFAULT_DELIVERY_POD_REQUIREMENT),
    coldChain: read(
      config,
      POD_COLD_CHAIN_REQUIREMENT_CONFIG_KEY,
      DEFAULT_DELIVERY_POD_COLD_CHAIN_REQUIREMENT,
    ),
    cod: read(config, POD_COD_REQUIREMENT_CONFIG_KEY, DEFAULT_DELIVERY_POD_COD_REQUIREMENT),
  };
}

function read(config: IConfigPort, key: string, fallback: string): PodRequirement {
  const configured = config.get<string>(key);
  const value = typeof configured === 'string' ? configured.trim().toUpperCase() : '';
  return ((DELIVERY_POD_REQUIREMENTS as readonly string[]).includes(value)
    ? value
    : fallback) as PodRequirement;
}
