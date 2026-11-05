import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { stagingTargetRefusal } from './staging-target';

export class StagingRefusedError extends Error {}

/**
 * The application context the staging CLIs run in (Work 80): every module, no HTTP listener, and
 * the process already declared a CLI (by the caller) so no background timer starts and no outbox
 * event is relayed here. The running staging backend relays what the seed writes, exactly as it
 * would for its own requests.
 *
 * Refuses before Nest starts when NODE_ENV or DATABASE_URL is wrong, and again once connected
 * if the live database is not the staging one.
 */
export async function createStagingContext(): Promise<INestApplicationContext> {
  const before = stagingTargetRefusal({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    currentDatabase: null,
  });
  if (before) throw new StagingRefusedError(before);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const rows = await app.get(PrismaService).$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    const after = stagingTargetRefusal({
      nodeEnv: process.env.NODE_ENV,
      databaseUrl: process.env.DATABASE_URL,
      currentDatabase: rows[0]?.db ?? '',
    });
    if (after) throw new StagingRefusedError(after);
    return app;
  } catch (err) {
    await app.close();
    throw err;
  }
}
