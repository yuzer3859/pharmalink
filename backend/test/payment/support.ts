import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { resetDatabase } from '../support/test-database';

/**
 * Module 07's repository contracts store `orderId`/`customerUserId`/`ownerId` as plain,
 * unconstrained `String` columns — confirmed against `prisma/schema/07-payment.prisma` (no
 * cross-module FK, ADR-002). These repository tests therefore need no Identity/Orders fixture
 * data: arbitrary strings are valid, exactly as they would be for a real cross-module scalar
 * reference validated at the application layer, not the database layer (mirrors
 * `test/orders/support.ts`'s identical finding for Module 06).
 *
 * No commands/controllers/module wiring exist yet for `payment` (this task's own boundary — the
 * ledger/payment foundation stops at repositories, exactly as Module 06's foundation task did),
 * so these tests connect a `PrismaService` directly against the throwaway container database
 * (`test/global-setup.ts`) rather than booting `AppModule` via `createTestApp()`.
 */
export async function createPrisma(): Promise<PrismaService> {
  const prisma = new PrismaService();
  await prisma.$connect();
  return prisma;
}

export async function resetPaymentTables(prisma: PrismaService): Promise<void> {
  await resetDatabase(prisma);
}

/** Unique-per-test reference, so a suite that does not reset between cases still cannot collide. */
export function uniqueRef(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}`;
}
