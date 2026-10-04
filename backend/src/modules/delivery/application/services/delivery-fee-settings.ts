import { IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_DELIVERY_FEE_BASE,
  DEFAULT_DELIVERY_FEE_MAXIMUM,
  DEFAULT_DELIVERY_FEE_MINIMUM,
  DEFAULT_DELIVERY_FEE_PER_KM,
  DEFAULT_DELIVERY_FEE_PRICING_VERSION,
  DEFAULT_DELIVERY_FEE_ROUND_TO,
  DeliveryFeeZoneSetting,
  parseDeliveryFeeZones,
} from '../../../../shared/config/delivery.config';
import { DeliveryFeeSettings } from '../../domain/services/delivery-fee-policy';

/** Dotted config keys backing the rate card. */
export const FEE_BASE_CONFIG_KEY = 'delivery.feeBase';
export const FEE_PER_KM_CONFIG_KEY = 'delivery.feePerKm';
export const FEE_MINIMUM_CONFIG_KEY = 'delivery.feeMinimum';
export const FEE_MAXIMUM_CONFIG_KEY = 'delivery.feeMaximum';
export const FEE_ROUND_TO_CONFIG_KEY = 'delivery.feeRoundTo';
export const FEE_PRICING_VERSION_CONFIG_KEY = 'delivery.feePricingVersion';
export const FEE_ZONES_CONFIG_KEY = 'delivery.feeZones';

/**
 * Reads the configured delivery rate card (F-FEE-01, BR-DEL-09, §13's "configurable").
 *
 * A free function rather than an injectable, mirroring `resolvePodSettings`: it is a projection of
 * configuration and holds nothing. Every caller that needs a fee — the HTTP quote route, Module
 * 06's checkout-quote, Module 06's checkout, and job creation's snapshot — resolves it from here,
 * which is what stops a delivery being priced one way when it is quoted and another way when it is
 * charged.
 *
 * ## Two encodings are resolved here, at the boundary, once
 *
 *  - **`feeMaximum: 0` means "no cap"**, and becomes `null` before the domain sees it. Zero is an
 *    env-var convenience — an unset variable already means "use the default", so there is no
 *    spelling of "absent" left — and letting it through as a literal zero would make the domain
 *    cap every delivery at nothing.
 *  - **`feeZones` may arrive already parsed or still as a string.** `deliveryConfig` parses it, so
 *    a normally-booted app hands over an array; a test harness or a future DB-backed `IConfigPort`
 *    (Module 16) may hand over the raw operator string instead. Both are accepted rather than one
 *    being assumed, because the alternative is a rate card that silently evaluates to no zones
 *    depending on which implementation is wired.
 *
 * `env.validation.ts` rejects an out-of-range or malformed value at boot, so the fall-backs below
 * only fire when a key is absent entirely. They fall back to the *documented defaults*, which are
 * all zero: an unreadable rate card must become no charge rather than an invented one.
 */
export function resolveDeliveryFeeSettings(config: IConfigPort): DeliveryFeeSettings {
  const maximum = readAmount(config, FEE_MAXIMUM_CONFIG_KEY, DEFAULT_DELIVERY_FEE_MAXIMUM);
  return {
    pricingVersion: readVersion(config),
    base: readAmount(config, FEE_BASE_CONFIG_KEY, DEFAULT_DELIVERY_FEE_BASE),
    perKm: readAmount(config, FEE_PER_KM_CONFIG_KEY, DEFAULT_DELIVERY_FEE_PER_KM),
    minimum: readAmount(config, FEE_MINIMUM_CONFIG_KEY, DEFAULT_DELIVERY_FEE_MINIMUM),
    maximum: maximum > 0 ? maximum : null,
    roundTo: readRoundTo(config),
    zones: readZones(config),
  };
}

function readAmount(config: IConfigPort, key: string, fallback: number): number {
  const value = config.get<number>(key);
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readRoundTo(config: IConfigPort): number {
  const value = config.get<number>(FEE_ROUND_TO_CONFIG_KEY);
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_DELIVERY_FEE_ROUND_TO;
}

function readVersion(config: IConfigPort): string {
  const value = config.get<string>(FEE_PRICING_VERSION_CONFIG_KEY);
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : DEFAULT_DELIVERY_FEE_PRICING_VERSION;
}

function readZones(config: IConfigPort): DeliveryFeeZoneSetting[] {
  const value = config.get<DeliveryFeeZoneSetting[] | string>(FEE_ZONES_CONFIG_KEY);
  if (typeof value === 'string') {
    return parseDeliveryFeeZones(value);
  }
  return Array.isArray(value) ? value : [];
}
