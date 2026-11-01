import { BootstrapRefusedError } from '../modules/identity/application/commands/bootstrap-super-admin.command';
import { EXIT_CREATED_NOT_SENT, EXIT_OK, EXIT_REFUSED, runBootstrapSuperAdmin } from './bootstrap-super-admin.runner';
import { CliIo } from './terminal-prompter';

const PASSWORD = 'Bootstr4pPassword';

function scriptedIo(answers: string[]) {
  const printed: string[] = [];
  const asked: string[] = [];
  const hidden: string[] = [];
  const queue = [...answers];
  const io: CliIo = {
    ask: async (q) => { asked.push(q); return queue.shift() ?? ''; },
    askHidden: async (q) => { hidden.push(q); return queue.shift() ?? ''; },
    print: (line) => printed.push(line),
    close: () => undefined,
  };
  return { io, printed, asked, hidden };
}

function command(result: unknown = { userId: 'user-1', maskedEmail: 'f***@example.com', delivery: 'SENT' }) {
  return {
    checkPreconditions: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue(result),
  };
}

describe('runBootstrapSuperAdmin', () => {
  it('reads the password twice through hidden prompts and never prints it', async () => {
    const c = command();
    const s = scriptedIo(['founder@example.com', PASSWORD, PASSWORD]);
    expect(await runBootstrapSuperAdmin(c, s.io)).toBe(EXIT_OK);
    expect(s.asked).toHaveLength(1);
    expect(s.hidden).toHaveLength(2);
    expect(c.execute).toHaveBeenCalledWith({ email: 'founder@example.com', password: PASSWORD });
    const output = s.printed.join('\n');
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain('founder@example.com');
    expect(output).toContain('PENDING_VERIFICATION');
    expect(output).toContain('POST /auth/verify-otp');
  });

  it('stops before asking for credentials when a precondition fails', async () => {
    const c = command();
    c.checkPreconditions.mockRejectedValue(new BootstrapRefusedError('EMAIL_NOT_CONFIGURED', 'E-mail delivery is not configured.'));
    const s = scriptedIo([]);
    expect(await runBootstrapSuperAdmin(c, s.io)).toBe(EXIT_REFUSED);
    expect(s.asked).toHaveLength(0);
    expect(c.execute).not.toHaveBeenCalled();
    expect(s.printed.join('\n')).toMatch(/Refused \(EMAIL_NOT_CONFIGURED\)[\s\S]*Nothing was created/);
  });

  it('creates nothing when the confirmation differs', async () => {
    const c = command();
    const s = scriptedIo(['founder@example.com', PASSWORD, `${PASSWORD}x`]);
    expect(await runBootstrapSuperAdmin(c, s.io)).toBe(EXIT_REFUSED);
    expect(c.execute).not.toHaveBeenCalled();
    expect(s.printed.join('\n')).not.toContain(PASSWORD);
  });

  it('lists unmet password requirements from a refusal', async () => {
    const c = command();
    c.execute.mockRejectedValue(new BootstrapRefusedError('WEAK_PASSWORD', 'The password does not meet the password policy.', ['Must contain a digit.']));
    const s = scriptedIo(['founder@example.com', 'weakpassword', 'weakpassword']);
    expect(await runBootstrapSuperAdmin(c, s.io)).toBe(EXIT_REFUSED);
    expect(s.printed).toContain('  - Must contain a digit.');
    expect(s.printed.join('\n')).not.toContain('weakpassword');
  });

  it('reports an unsent e-mail truthfully and points to the resend flow', async () => {
    const c = command({ userId: 'user-1', maskedEmail: 'f***@example.com', delivery: 'NOT_SENT', retryAfterSeconds: 30 });
    const s = scriptedIo(['founder@example.com', PASSWORD, PASSWORD]);
    expect(await runBootstrapSuperAdmin(c, s.io)).toBe(EXIT_CREATED_NOT_SENT);
    const output = s.printed.join('\n');
    expect(output).toContain('was NOT sent');
    expect(output).toContain('after 30 seconds');
    expect(output).toContain('POST /auth/resend-otp');
    expect(output).not.toMatch(/code was e-mailed/);
  });
});
