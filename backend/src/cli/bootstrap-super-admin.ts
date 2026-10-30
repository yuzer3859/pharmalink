import { declareCliProcess } from '../shared/config/process-role';
import { BootstrapSuperAdminCommand } from '../modules/identity/application/commands/bootstrap-super-admin.command';
import { createBootstrapContext } from './bootstrap-context';
import { EXIT_REFUSED, runBootstrapSuperAdmin } from './bootstrap-super-admin.runner';
import { createTerminalPrompter } from './terminal-prompter';

/**
 * `npm run admin:bootstrap-super-admin` (Work 65). Operator-only: run it in a backend environment
 * that has database access, the same Redis as the server (OTP_STORE=redis) and Resend configured.
 * It takes no arguments; the e-mail and password are typed interactively, and the password is never
 * echoed. See backend/docs/first-super-admin-bootstrap.md.
 */
async function main(): Promise<void> {
  declareCliProcess();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Run this command in an interactive terminal: the password is read from the keyboard, never from arguments or a pipe.');
    process.exitCode = EXIT_REFUSED;
    return;
  }

  const app = await createBootstrapContext();
  const io = createTerminalPrompter();
  try {
    process.exitCode = await runBootstrapSuperAdmin(app.get(BootstrapSuperAdminCommand), io);
  } finally {
    io.close();
    await app.close();
  }
}

main().catch((err: unknown) => {
  // The command never puts a credential in an error; print only the message.
  console.error(`Bootstrap failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
