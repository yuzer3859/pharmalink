/**
 * Re-exported Prisma enums (module-06 `06-orders-spec.md` §3.10), same pattern as Modules
 * 02/03/04/05's own `domain/enums.ts` — the domain layer depends on the enum shape, not on
 * `@prisma/client` as a whole.
 */
export { CartStatus, OrderStatus, OrderStrategy, OrderLineStatus, FulfillmentStatus } from '@prisma/client';
