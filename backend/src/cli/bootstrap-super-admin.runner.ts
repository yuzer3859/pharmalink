import {
  BootstrapRefusedError,
  BootstrapSuperAdminCommand,
} from '../modules/identity/application/commands/bootstrap-super-admin.command';
import { CliIo } from './terminal-prompter';

/** Exit codes: 0 created and e-mail sent; 2 refused, nothing created; 3 created, e-mail not sent. */
export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;
export const EXIT_CREATED_NOT_SENT = 3;

type Bootstrapper = Pick<BootstrapSuperAdminCommand, 'checkPreconditions' | 'execute'>;

/**
 * The operator conversation of `npm run admin:bootstrap-super-admin` (Work 65). Prints no secret:
 * not the password, its hash, the verification code or any token. Only a masked e-mail and ids.
 */
export async function runBootstrapSuperAdmin(command: Bootstrapper, io: CliIo): Promise<number> {
  io.print('PharmaLink: one-time first Super Admin bootstrap (development/staging only).');
  try {
    await command.checkPreconditions();
  } catch (err) {
    if (err instanceof BootstrapRefusedError) return refused(io, err);
    throw err;
  }

  const email = (await io.ask('E-mail address for the first Super Admin: ')).trim();
  const password = await io.askHidden('Password (not shown): ');
  const confirmation = await io.askHidden('Confirm password (not shown): ');
  if (password !== confirmation) {
    io.print('The passwords do not match. Nothing was created.');
    return EXIT_REFUSED;
  }

  let result;
  try {
    result = await command.execute({ email, password });
  } catch (err) {
    if (err instanceof BootstrapRefusedError) return refused(io, err);
    throw err;
  }

  io.print(`Created the first Super Admin (user ${result.userId}) for ${result.maskedEmail}.`);
  io.print('The account is PENDING_VERIFICATION and cannot sign in until its e-mail is verified.');
  if (result.delivery === 'SENT') {
    io.print(`A verification code was e-mailed to ${result.maskedEmail}. Verify it with`);
    io.print('POST /auth/verify-otp { identifier: <e-mail>, code: <code>, purpose: "REGISTER" }.');
    io.print('The bootstrap is now permanently complete for this database.');
    return EXIT_OK;
  }
  const wait = result.retryAfterSeconds ? ` after ${result.retryAfterSeconds} seconds` : '';
  io.print('The verification e-mail was NOT sent, and no code was delivered.');
  io.print(`Request a new code${wait} with POST /auth/resend-otp { identifier: <e-mail>, purpose: "REGISTER" }.`);
  io.print('The bootstrap is complete and will not run again; recover the account through resend, not a new bootstrap.');
  return EXIT_CREATED_NOT_SENT;
}

function refused(io: CliIo, err: BootstrapRefusedError): number {
  io.print(`Refused (${err.reason}): ${err.message}`);
  for (const requirement of err.requirements) io.print(`  - ${requirement}`);
  io.print('Nothing was created.');
  return EXIT_REFUSED;
}
