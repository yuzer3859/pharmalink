import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as not requiring authentication (JwtAuthGuard short-circuits). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
