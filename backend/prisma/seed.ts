import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, ROLES, seedRbacCatalog } from './rbac-catalog';

const prisma = new PrismaClient();

/**
 * Seeds the system roles and permission catalog (module-01 §5, §6.2). Idempotent — safe to
 * re-run in any environment (roadmap §4.3). The catalog itself lives in ./rbac-catalog so the
 * integration-test harness seeds exactly what development and production seed.
 *
 * Note: additive only. It never removes a grant that is no longer listed, because role
 * permissions are editable at runtime via POST /admin/rbac/roles/{id}/permissions and pruning
 * here would silently revert a deliberate admin change.
 */
async function main(): Promise<void> {
  await seedRbacCatalog(prisma);
  console.log(`Seeded ${ROLES.length} roles and ${PERMISSIONS.length + 1} permissions.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
