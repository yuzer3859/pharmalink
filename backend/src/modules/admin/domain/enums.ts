/**
 * Re-exported Prisma enums (module-16 §5.2), the same pattern every other module's
 * `domain/enums.ts` follows — the domain depends on the enum shape, not on `@prisma/client`.
 *
 * `ConfigValueType` is the only one this work introduces. `FeatureFlagStatus` was scaffolded in
 * Phase 0 and is adopted rather than replaced: `ENABLED`/`DISABLED` is exactly the on/off a flag
 * needs, and `PARTIAL` is never written by this work because no percentage-rollout evaluator
 * exists to honour it (§9 of the work brief).
 */
export { ConfigValueType, FeatureFlagStatus } from '@prisma/client';
