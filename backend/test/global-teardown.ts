import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedTestContainer } from 'testcontainers';

module.exports = async function globalTeardown(): Promise<void> {
  const container = (globalThis as Record<string, unknown>).__PG_CONTAINER__ as
    | StartedPostgreSqlContainer
    | undefined;

  if (container) {
    await container.stop();
  }

  const redis = (globalThis as Record<string, unknown>).__REDIS_CONTAINER__ as
    | StartedTestContainer
    | undefined;

  if (redis) {
    await redis.stop();
  }
};
