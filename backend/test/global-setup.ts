import { execFileSync } from 'child_process';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { TEST_DATABASE_NAME } from './support/test-database';

/**
 * Boots a disposable Postgres container, applies the real Prisma migrations against it and
 * exports its connection URL to the test workers. Nothing here touches any pre-existing
 * database: the container gets an ephemeral random host port, so a Postgres already running on
 * 5432 (a typical local dev database) is untouched.
 */
module.exports = async function globalSetup(): Promise<void> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16')
    .withDatabase(TEST_DATABASE_NAME)
    .withUsername('pharmalink')
    .withPassword('pharmalink')
    .start();

  const databaseUrl = container.getConnectionUri();

  // Jest runs globalSetup in the parent process before forking workers, so these assignments are
  // inherited by every worker.
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';
  // Test-only secrets. Deliberately fake: no integration test may depend on a real credential.
  process.env.JWT_ACCESS_SECRET ??= 'e2e-access-secret-value-0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'e2e-refresh-secret-value-0123456789';
  process.env.MASTER_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.OTP_TTL_SECONDS ??= '300';
  // A non-zero platform commission for the whole e2e suite (5%, as a fraction — see
  // `orders.config.ts`). Deliberately configured here rather than defaulted in application code:
  // the commission is a business value an operator sets, and baking one into the app would ship a
  // rate nobody chose. Non-zero matters because a zero fee hides real behaviour — it makes
  // `PLATFORM_REVENUE` and the fee clawback trivially correct, and the interaction between a
  // platform-funded coupon and a commission charged on the *pre-discount* subtotal (ADR-019)
  // untestable. `??=` so a developer can still override it for a single run.
  process.env.ORDERS_PLATFORM_FEE_PERCENT ??= '0.05';

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    shell: true,
  });

  (globalThis as Record<string, unknown>).__PG_CONTAINER__ = container;

  console.log(`\n[e2e] Postgres ready on port ${container.getPort()} (${TEST_DATABASE_NAME})`);

  // A throwaway Redis for the delivery tracking suite, on the same disposable-container pattern as
  // Postgres above and an ephemeral port for the same reason — a developer's own Redis on 6379 is
  // left alone.
  //
  // Exported as `REDIS_TEST_URL`, deliberately **not** as `REDIS_URL`. Redis is optional by design
  // (see `redis.config.ts`), and setting it here would quietly opt every one of the two dozen e2e
  // suites into opening connections they have no use for. The tracking suite promotes it to
  // `REDIS_URL` for its own app instances; everything else keeps booting exactly as it did, which
  // also keeps the unconfigured single-node path continuously exercised rather than letting it
  // become a branch nothing runs.
  const redis: StartedTestContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  process.env.REDIS_TEST_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  (globalThis as Record<string, unknown>).__REDIS_CONTAINER__ = redis;

  console.log(`[e2e] Redis ready on port ${redis.getMappedPort(6379)}`);
};
