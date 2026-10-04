import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { resetDatabase } from '../support/test-database';

/**
 * Module 05's repository contracts (module-05 §2.1 "no cross-module table reads or Prisma
 * relations", ADR-002) store `customerUserId`/`pharmacyId`/`orderId`/etc. as plain, unconstrained
 * `String` columns — confirmed against `prisma/schema/05-prescription.prisma` and the init
 * migration (no FK). These repository tests therefore need no Identity/Catalog/Pharmacy fixture
 * data: arbitrary strings are valid, exactly as they would be for a real cross-module scalar
 * reference validated at the application layer, not the database layer.
 *
 * No commands/controllers/module wiring exist yet for `prescription-matching` (this task's own
 * boundary — see `05-prescription-matching-spec.md` Task 6), so these tests connect a
 * `PrismaService` directly against the throwaway container database (`test/global-setup.ts`)
 * rather than booting `AppModule` via `createTestApp()` (`test/support/test-app.ts`), which would
 * require wiring a Nest module for this slice that this task does not build.
 */
export async function createPrisma(): Promise<PrismaService> {
  const prisma = new PrismaService();
  await prisma.$connect();
  return prisma;
}

export async function resetPrescriptionMatchingTables(prisma: PrismaService): Promise<void> {
  await resetDatabase(prisma);
}
