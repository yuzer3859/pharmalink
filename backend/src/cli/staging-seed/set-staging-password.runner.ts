import { CliIo } from '../terminal-prompter';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;

export interface SignInFixture {
  userId: string;
  email: string;
  hasPassword: boolean;
}

/**
 * What the runner needs from Identity (Work 80). The real implementation hashes with the backend's
 * hasher, saves through the user repository, revokes the account's sessions and refresh tokens,
 * and writes an audit entry; it never returns or logs the password or its hash.
 */
export interface FixturePasswordStore {
  find(email: string): Promise<SignInFixture | null>;
  /** Unmet password-policy requirements; empty when the password is acceptable. */
  policyFailures(password: string): string[];
  setPassword(userId: string, password: string): Promise<void>;
}

export interface SignInAccount {
  email: string;
  /** ADMIN-type accounts must enrol an authenticator at their first sign-in. */
  administrator: boolean;
}

/**
 * `npm run staging:set-password` (Work 80): the owner sets the password of a staging sign-in
 * fixture (the seeded ADMIN or FINANCE_OFFICER) at the keyboard. Only those accounts can be
 * chosen; the password is read twice without echo and is never printed, logged or passed on the
 * command line. Setting it again replaces it and signs the account out everywhere.
 */
export async function runSetStagingPassword(
  store: FixturePasswordStore,
  io: CliIo,
  accounts: readonly SignInAccount[],
): Promise<number> {
  io.print('PharmaLink staging: set the password of a seeded sign-in account.');
  const fixtures: SignInFixture[] = [];
  for (const { email } of accounts) {
    const found = await store.find(email);
    if (found) fixtures.push(found);
  }
  if (fixtures.length === 0) {
    io.print('No seeded sign-in accounts exist yet. Run the staging seed first (npm run staging:seed).');
    return EXIT_REFUSED;
  }
  fixtures.forEach((f, i) => io.print(`  ${i + 1}. ${f.email}${f.hasPassword ? ' (has a password; setting it again signs it out everywhere)' : ''}`));

  const choice = Number.parseInt((await io.ask(`Account number (1-${fixtures.length}): `)).trim(), 10);
  const fixture = Number.isInteger(choice) ? fixtures[choice - 1] : undefined;
  if (!fixture) {
    io.print('No such account. Nothing was changed.');
    return EXIT_REFUSED;
  }

  const password = await io.askHidden('New password (not shown): ');
  const confirmation = await io.askHidden('Confirm password (not shown): ');
  if (password !== confirmation) {
    io.print('The passwords do not match. Nothing was changed.');
    return EXIT_REFUSED;
  }
  const failures = store.policyFailures(password);
  if (failures.length > 0) {
    io.print('The password does not meet the password policy. Nothing was changed:');
    for (const failure of failures) io.print(`  - ${failure}`);
    return EXIT_REFUSED;
  }

  await store.setPassword(fixture.userId, password);
  io.print(`Password set for ${fixture.email}.`);
  io.print('Sign in at the portal with this e-mail and password.');
  if (accounts.find((a) => a.email === fixture.email)?.administrator) {
    io.print('As an administrator, the first sign-in asks you to enrol an authenticator app.');
  }
  return EXIT_OK;
}
