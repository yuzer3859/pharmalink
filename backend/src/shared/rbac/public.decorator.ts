import { SetMetadata } from '@nestjs/common';

/**
 * Route metadata read by the global `JwtAuthGuard`. Lives in the shared kit, beside
 * `PERMISSIONS_KEY`, because shared infrastructure (the health endpoints) needs it as well as the
 * feature modules; `modules/identity/interface/decorators/public.decorator.ts` re-exports it.
 */
export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as not requiring authentication (JwtAuthGuard short-circuits). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
