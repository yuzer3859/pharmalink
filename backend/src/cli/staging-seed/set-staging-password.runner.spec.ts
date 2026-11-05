import { CliIo } from '../terminal-prompter';
import { EXIT_OK, EXIT_REFUSED, FixturePasswordStore, runSetStagingPassword, SignInAccount } from './set-staging-password.runner';

const ACCOUNTS: SignInAccount[] = [
  { email: 'admin@staging.pharmalink.test', administrator: true },
  { email: 'finance@staging.pharmalink.test', administrator: false },
];
const SECRET = 'Corr3ct-Horse-Battery';

function scriptedIo(answers: string[]) {
  const queue = [...answers];
  const printed: string[] = [];
  const hidden: string[] = [];
  const io: CliIo = {
    ask: async () => queue.shift() ?? '',
    askHidden: async (q) => {
      hidden.push(q);
      return queue.shift() ?? '';
    },
    print: (line) => printed.push(line),
    close: () => undefined,
  };
  return { io, printed, hidden };
}

function store(overrides: Partial<FixturePasswordStore> = {}) {
  const setPassword = jest.fn().mockResolvedValue(undefined);
  const s: FixturePasswordStore = {
    find: async (email) => ({ userId: `id-${email.split('@')[0]}`, email, hasPassword: false }),
    policyFailures: (p) => (p.length >= 8 ? [] : ['Must be at least 8 characters.']),
    setPassword,
    ...overrides,
  };
  return { s, setPassword };
}

describe('runSetStagingPassword (Work 80)', () => {
  it('sets the chosen account password read twice through hidden prompts, and never prints it', async () => {
    const { io, printed, hidden } = scriptedIo(['1', SECRET, SECRET]);
    const { s, setPassword } = store();
    await expect(runSetStagingPassword(s, io, ACCOUNTS)).resolves.toBe(EXIT_OK);
    expect(setPassword).toHaveBeenCalledWith('id-admin', SECRET);
    expect(hidden).toHaveLength(2);
    expect(printed.join('\n')).not.toContain(SECRET);
    expect(printed.join('\n')).toMatch(/enrol an authenticator/);
  });

  it('does not mention an authenticator for the finance officer', async () => {
    const { io, printed } = scriptedIo(['2', SECRET, SECRET]);
    const { s, setPassword } = store();
    await expect(runSetStagingPassword(s, io, ACCOUNTS)).resolves.toBe(EXIT_OK);
    expect(setPassword).toHaveBeenCalledWith('id-finance', SECRET);
    expect(printed.join('\n')).not.toMatch(/authenticator/);
  });

  it.each([['0'], ['3'], ['admin'], ['']])('refuses the choice %p and changes nothing', async (choice) => {
    const { io } = scriptedIo([choice, SECRET, SECRET]);
    const { s, setPassword } = store();
    await expect(runSetStagingPassword(s, io, ACCOUNTS)).resolves.toBe(EXIT_REFUSED);
    expect(setPassword).not.toHaveBeenCalled();
  });

  it('refuses mismatched passwords', async () => {
    const { io, printed } = scriptedIo(['1', SECRET, `${SECRET}x`]);
    const { s, setPassword } = store();
    await expect(runSetStagingPassword(s, io, ACCOUNTS)).resolves.toBe(EXIT_REFUSED);
    expect(setPassword).not.toHaveBeenCalled();
    expect(printed.join('\n')).toMatch(/do not match/);
  });

  it('refuses a password the policy rejects and lists why, without echoing it', async () => {
    const { io, printed } = scriptedIo(['1', 'short', 'short']);
    const { s, setPassword } = store();
    await expect(runSetStagingPassword(s, io, ACCOUNTS)).resolves.toBe(EXIT_REFUSED);
    expect(setPassword).not.toHaveBeenCalled();
    expect(printed.join('\n')).toMatch(/at least 8 characters/);
    expect(printed.join('\n')).not.toMatch(/\bshort\b/);
  });

  it('refuses when the seed has not run', async () => {
    const { io, printed } = scriptedIo(['1', SECRET, SECRET]);
    const { s, setPassword } = store({ find: async () => null });
    await expect(runSetStagingPassword(s, io, ACCOUNTS)).resolves.toBe(EXIT_REFUSED);
    expect(setPassword).not.toHaveBeenCalled();
    expect(printed.join('\n')).toMatch(/staging:seed/);
  });

  it('offers only the seeded sign-in accounts it is given', async () => {
    const { io, printed } = scriptedIo(['9']);
    const { s } = store();
    await runSetStagingPassword(s, io, ACCOUNTS);
    const listed = printed.filter((l) => /^\s+\d+\. /.test(l));
    expect(listed).toHaveLength(2);
    expect(listed.join('\n')).not.toMatch(/operator|owner|yuzer/);
  });
});
