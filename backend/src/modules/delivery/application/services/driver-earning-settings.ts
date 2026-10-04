import { IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_DELIVERY_EARNING_BASE,
  DEFAULT_DELIVERY_EARNING_FEE_SHARE_PERCENT,
  DEFAULT_DELIVERY_EARNING_MAXIMUM,
  DEFAULT_DELIVERY_EARNING_MINIMUM,
  DEFAULT_DELIVERY_EARNING_PER_KM,
  DEFAULT_DELIVERY_EARNING_ROUND_TO,
  DEFAULT_DELIVERY_EARNING_VERSION,
} from '../../../../shared/config/delivery.config';
import { DriverEarningSettings } from '../../domain/services/driver-earning-policy';

/** Dotted config keys backing the earning agreement. */
export const EARNING_BASE_CONFIG_KEY = 'delivery.earningBase';
export const EARNING_PER_KM_CONFIG_KEY = 'delivery.earningPerKm';
export const EARNING_FEE_SHARE_PERCENT_CONFIG_KEY = 'delivery.earningFeeSharePercent';
export const EARNING_MINIMUM_CONFIG_KEY = 'delivery.earningMinimum';
export const EARNING_MAXIMUM_CONFIG_KEY = 'delivery.earningMaximum';
export const EARNING_ROUND_TO_CONFIG_KEY = 'delivery.earningRoundTo';
export const EARNING_VERSION_CONFIG_KEY = 'delivery.earningVersion';

/**
 * Reads the configured driver-earning agreement (F-ERN-01, BR-DEL-10, §3's configuration seam).
 *
 * A free function rather than an injectable, mirroring `resolvePodSettings` and
 * `resolveDeliveryFeeSettings`: it is a projection of configuration and holds nothing. The accrual
 * command is its only caller today, which is deliberate — an earning is computed once, at accrual,
 * and stamped with the version it used, so nothing downstream ever needs to resolve the agreement
 * again to explain an amount.
 *
 * `earningMaximum: 0` means **no cap** and becomes `null` before the domain sees it, for the reason
 * `resolveDeliveryFeeSettings` gives about its own ceiling: an unset variable already means "use
 * the default", so a literal zero cap would be an agreement that pays nothing.
 *
 * `env.validation.ts` rejects an out-of-range value at boot, so the fall-backs below only fire when
 * a key is absent entirely — a test harness with a bare config, say. They fall back to the
 * documented defaults, which are all zero: an unreadable agreement must accrue nothing rather than
 * an invented amount, because the invented amount would be a real liability to a real person.
 */
export function resolveDriverEarningSettings(config: IConfigPort): DriverEarningSettings {
  const maximum = readAmount(config, EARNING_MAXIMUM_CONFIG_KEY, DEFAULT_DELIVERY_EARNING_MAXIMUM);
  return {
    calculationVersion: readVersion(config),
    base: readAmount(config, EARNING_BASE_CONFIG_KEY, DEFAULT_DELIVERY_EARNING_BASE),
    perKm: readAmount(config, EARNING_PER_KM_CONFIG_KEY, DEFAULT_DELIVERY_EARNING_PER_KM),
    feeSharePercent: readFraction(config),
    minimum: readAmount(config, EARNING_MINIMUM_CONFIG_KEY, DEFAULT_DELIVERY_EARNING_MINIMUM),
    maximum: maximum > 0 ? maximum : null,
    roundTo: readRoundTo(config),
  };
}

function readAmount(config: IConfigPort, key: string, fallback: number): number {
  const value = config.get<number>(key);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readFraction(config: IConfigPort): number {
  const value = config.get<number>(EARNING_FEE_SHARE_PERCENT_CONFIG_KEY);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_DELIVERY_EARNING_FEE_SHARE_PERCENT;
}

function readRoundTo(config: IConfigPort): number {
  const value = config.get<number>(EARNING_ROUND_TO_CONFIG_KEY);
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_DELIVERY_EARNING_ROUND_TO;
}

function readVersion(config: IConfigPort): string {
  const value = config.get<string>(EARNING_VERSION_CONFIG_KEY);
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : DEFAULT_DELIVERY_EARNING_VERSION;
}
