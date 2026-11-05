import { INestApplicationContext } from '@nestjs/common';
import { declareCliProcess } from '../shared/config/process-role';
import { AuditService } from '../shared/audit/audit.service';
import { HASHER, IHasher } from '../modules/identity/application/ports/hasher.port';
import {
  IRefreshTokenRepository,
  ISessionRepository,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
} from '../modules/identity/domain/repositories/auth.repositories';
import { IUserRepository, USER_REPOSITORY } from '../modules/identity/domain/repositories/user.repository';
import { PasswordPolicy } from '../modules/identity/domain/value-objects/password-policy';
import { FIXTURE_ACCOUNTS } from './staging-seed/fixtures';
import { EXIT_REFUSED, FixturePasswordStore, runSetStagingPassword } from './staging-seed/set-staging-password.runner';
import { createStagingContext, StagingRefusedError } from './staging-seed/staging-context';
import { createTerminalPrompter } from './terminal-prompter';

/** Identity's own ports: policy, hasher, repository, session revocation and the audit trail. */
function identityStore(app: INestApplicationContext): FixturePasswordStore {
  const users = app.get<IUserRepository>(USER_REPOSITORY);
  const policy = new PasswordPolicy();
  return {
    async find(email) {
      const user = await users.findByEmail(email);
      return user ? { userId: user.id, email, hasPassword: user.passwordHash !== null } : null;
    },
    policyFailures: (password) => policy.check(password),
    async setPassword(userId, password) {
      const user = await users.findById(userId);
      if (!user) throw new Error('The account disappeared while the password was being set.');
      user.changePassword(await app.get<IHasher>(HASHER).hash(password));
      await users.save(user);
      const sessions = await app.get<ISessionRepository>(SESSION_REPOSITORY).revokeAllForUser(userId);
      await app.get<IRefreshTokenRepository>(REFRESH_TOKEN_REPOSITORY).revokeAllForUser(userId);
      await app.get(AuditService).record({
        actorUserId: null,
        action: 'staging.fixture_password_set',
        resourceType: 'user',
        resourceId: userId,
        context: { sessionsRevoked: sessions, via: 'npm run staging:set-password' },
      });
    },
  };
}

/**
 * `npm run staging:set-password` (Work 80): the owner sets the password of the seeded ADMIN or
 * FINANCE_OFFICER at the keyboard. Staging only, interactive terminal only. On the staging stack:
 *   docker compose -f compose.staging.yml --env-file backend/.env.staging --profile tools run --rm tools npm run staging:set-password
 */
async function main(): Promise<void> {
  declareCliProcess();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Run this command in an interactive terminal: the password is read from the keyboard, never from arguments or a pipe.');
    process.exitCode = EXIT_REFUSED;
    return;
  }
  const app = await createStagingContext();
  const io = createTerminalPrompter();
  try {
    const accounts = FIXTURE_ACCOUNTS.filter((a) => a.signIn).map((a) => ({
      email: a.email!,
      administrator: a.primaryRole === 'ADMIN',
    }));
    process.exitCode = await runSetStagingPassword(identityStore(app), io, accounts);
  } finally {
    io.close();
    await app.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof StagingRefusedError) {
    console.error(`Refused: ${err.message}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  // Nothing here puts a credential in an error; print only the message.
  console.error(`Setting the password failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
