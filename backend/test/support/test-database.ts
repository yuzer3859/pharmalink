import { PrismaClient } from '@prisma/client';
import { seedRbacCatalog } from '../../prisma/rbac-catalog';

/**
 * Database name the harness creates. Every destructive helper asserts against it, so a
 * misconfigured DATABASE_URL aborts instead of truncating a developer's real database.
 */
export const TEST_DATABASE_NAME = 'pharmalink_e2e';

/**
 * Guard rail. `resetDatabase` runs TRUNCATE across every table, so being pointed at the wrong
 * database would be destructive and unrecoverable. Refuse anything that is not the disposable
 * container database.
 */
export function assertTestDatabase(url: string | undefined): string {
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Integration tests must be run via `npm run test:e2e`, which ' +
        'starts a throwaway Postgres container and injects its URL.',
    );
  }
  if (!url.includes(`/${TEST_DATABASE_NAME}`)) {
    throw new Error(
      `Refusing to run destructive integration tests against "${url}". ` +
        `The database name must be "${TEST_DATABASE_NAME}".`,
    );
  }
  return url;
}

/**
 * Tables truncated between tests. `_prisma_migrations` is deliberately excluded — wiping it
 * would make Prisma believe the schema is unmigrated.
 */
const TRUNCATE_EXCLUDED = new Set(['_prisma_migrations']);

let cachedTables: string[] | null = null;

async function tableNames(prisma: PrismaClient): Promise<string[]> {
  if (cachedTables) {
    return cachedTables;
  }
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
  `;
  const tables = rows.map((r) => r.table_name).filter((t) => !TRUNCATE_EXCLUDED.has(t));

  if (tables.length === 0) {
    const dbInfo = await prisma.$queryRaw<Array<{ db: string; schema: string }>>`
      SELECT current_database() AS db, current_schema() AS schema
    `;
    throw new Error(
      'Found no tables to truncate — migrations have probably not been applied to the test ' +
        `database. Connected to db="${dbInfo[0]?.db}" schema="${dbInfo[0]?.schema}".`,
    );
  }

  cachedTables = tables;
  return cachedTables;
}

/**
 * Truncates every table and re-applies the RBAC catalog, giving each test a clean, identically
 * seeded database. TRUNCATE ... CASCADE in a single statement avoids FK ordering problems and is
 * dramatically faster than deleting row-by-row.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  assertTestDatabase(process.env.DATABASE_URL);

  const tables = await tableNames(prisma);
  const quoted = tables.map((t) => `"public"."${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

  await seedRbacCatalog(prisma);
}
