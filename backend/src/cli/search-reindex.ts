import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SearchProjectorService } from '../modules/search/application/search-projector.service';
import { declareCliProcess } from '../shared/config/process-role';

/**
 * Work 98: `npm run search:reindex` rebuilds Module 14's projections from the catalogue and
 * pharmacy stock. Idempotent; it writes only Search's own tables.
 */
async function main(): Promise<void> {
  declareCliProcess();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const report = await app.get(SearchProjectorService).reindexAll();
    console.log(`Search reindex complete: ${report.products} products, ${report.pharmacies} pharmacies indexed, ${report.failures} failures.`);
    if (report.failures > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(`Search reindex failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
