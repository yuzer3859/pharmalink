import { declareCliProcess } from '../shared/config/process-role';
import { FIXTURE_ACCOUNTS } from './staging-seed/fixtures';
import { createStagingContext, StagingRefusedError } from './staging-seed/staging-context';
import { StagingSeeder } from './staging-seed/staging-seeder';

const EXIT_REFUSED = 2;

/**
 * `npm run staging:seed` (Work 80): builds the staging verification baseline. Staging only: it
 * refuses NODE_ENV=production or test, and any database but `pharmalink_staging`. Idempotent: run
 * it again and it reports everything as existing. See ops/staging/README.md.
 *
 * On the staging stack:
 *   docker compose -f compose.staging.yml --env-file backend/.env.staging run --rm tools npm run staging:seed
 */
async function main(): Promise<void> {
  declareCliProcess();
  const app = await createStagingContext();
  try {
    const summary = await new StagingSeeder(app, (line) => console.log(`  ${line}`)).run();
    console.log(`Staging seed complete: ${summary.created.length} created, ${summary.existing.length} already present.`);
    const signIn = FIXTURE_ACCOUNTS.filter((a) => a.signIn);
    console.log('Sign-in accounts (no password until you set one with `npm run staging:set-password`):');
    for (const account of signIn) console.log(`  ${account.email}  (${account.primaryRole})`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof StagingRefusedError) {
    console.error(`Refused: ${err.message}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  console.error(`Staging seed failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
