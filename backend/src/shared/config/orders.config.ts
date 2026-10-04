import { registerAs } from '@nestjs/config';

/**
 * The environment variable backing `orders.platformFeePercent`.
 *
 * Named to match the dotted config key every caller already reads, so the two are findable from
 * each other. The value is a **fraction, not a percentage number**: `0.05` means 5%. That is
 * `PricingCalculator`'s existing contract (`platformFeePercent`, "0–1", multiplied directly by the
 * subtotal), and this variable feeds that function unchanged — naming it `..._PERCENT` while
 * carrying `0.05` is the lesser evil against renaming a key four call sites already use.
 */
export const ORDERS_PLATFORM_FEE_PERCENT_ENV = 'ORDERS_PLATFORM_FEE_PERCENT';

/**
 * What the platform charges when the variable is unset.
 *
 * **Zero, deliberately.** This is the commission the platform takes on every order, and there is
 * no safe non-zero default: guessing one here would silently start charging pharmacies a rate
 * nobody configured. An operator who wants a commission sets it explicitly; an operator who sets
 * nothing gets the behaviour the platform has had all along, rather than a surprise.
 */
export const DEFAULT_ORDERS_PLATFORM_FEE_PERCENT = 0;

/** Parses the env value, falling back to the default when unset or blank. */
export function readPlatformFeePercent(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[ORDERS_PLATFORM_FEE_PERCENT_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_ORDERS_PLATFORM_FEE_PERCENT;
  }
  return Number(raw);
}

/**
 * The `orders` configuration namespace.
 *
 * ## Why this exists at all
 *
 * `orders.platformFeePercent` has been read through `IConfigPort` since Module 06's checkout
 * landed, by `CheckoutCommand`, `QuoteCheckoutCommand`, `ValidateCartCommand` and
 * `GetActiveCartQuery` — but nothing ever *registered* it. `ConfigService` had no source for a
 * dotted key, so every one of those reads returned `undefined` and fell through to its `?? 0`,
 * and the platform's commission was structurally pinned at zero no matter what an operator set.
 * This namespace is that missing source: it makes the key an explicitly configured, validated
 * value rather than a permanently-absent one.
 *
 * The `?? 0` fallbacks at the call sites stay. They are now genuinely unreachable for this key,
 * but they also guard against a future `IConfigPort` implementation (Module 16's DB-backed one)
 * returning nothing, and removing them would make a misconfiguration a crash instead of a
 * conservative zero.
 *
 * ## Why only this key
 *
 * `orders.deliveryFeeFlat` had exactly the same gap and is **still** deliberately left
 * unregistered, but the reason has changed. It is no longer the platform's delivery fee: Module 08
 * owns that calculation now (`IDeliveryPricingPort`, F-FEE-01/BR-DEL-09), and both checkout paths
 * take their amount from there. What still reads this key is the pair of cart-level views —
 * `/cart` and `/cart/validate` — which have no address and no matched pharmacy and therefore
 * nothing to route between; for them it resolves to `0`, which is also what the shipped delivery
 * rate card charges. Registering it here would create a second, flat delivery fee competing with
 * the real one, which is precisely the duplication the cross-module boundary exists to avoid.
 *
 * Validation lives in `env.validation.ts` alongside every other variable the app reads, so an
 * out-of-range rate fails at boot rather than at the first checkout.
 */
export const ordersConfig = registerAs('orders', () => ({
  platformFeePercent: readPlatformFeePercent(),
}));
