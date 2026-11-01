import { randomBytes } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { IAdminMfaRepository } from '../../domain/repositories/admin-mfa.repository';
import { AesGcmMfaSecretCipher } from '../../infrastructure/security/aes-gcm-mfa-secret.cipher';
import { AdminMfaPolicy, AdminMfaReadiness } from '../services/admin-mfa-policy.service';
import { AccountStatus, OtpPurpose, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { BootstrapInspection, IPlatformBootstrapRepository } from '../../domain/repositories/platform-bootstrap.repository';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IHasher } from '../ports/hasher.port';
import { INotificationPort } from '../ports/notification.port';
import { IOtpStoreProbe } from '../ports/otp-store-probe.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { BootstrapRefusedError, BootstrapSuperAdminCommand } from './bootstrap-super-admin.command';
import { ResendOtpCommand } from './resend-otp.command';

const PASSWORD = 'Bootstr4pPassword';
const HASH = 'scrypt$hashed-value';
const ready = (): BootstrapInspection => ({
  completed: false,
  superAdminExists: false,
  superAdminRole: { id: 'role-sa', scope: 'PLATFORM', hasWildcard: true },
});

const mfaReady = (): AdminMfaReadiness => ({ enforced: true, keyConfigured: true, schemaReady: true });

function build(overrides: { mfa?: AdminMfaReadiness | AdminMfaPolicy; state?: BootstrapInspection } = {}) {
  const mfaPolicy =
    overrides.mfa instanceof AdminMfaPolicy
      ? overrides.mfa
      : ({ readiness: jest.fn().mockResolvedValue(overrides.mfa ?? mfaReady()) } as unknown as AdminMfaPolicy);
  const bootstrap = {
    inspect: jest.fn().mockResolvedValue(overrides.state ?? ready()),
    assignSuperAdminRole: jest.fn().mockResolvedValue({ assignmentId: 'assignment-1' }),
    markCompleted: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<IPlatformBootstrapRepository>;
  const users = {
    findByEmail: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'user-1' }),
  } as unknown as jest.Mocked<IUserRepository>;
  const hasher = { hash: jest.fn().mockResolvedValue(HASH) } as unknown as jest.Mocked<IHasher>;
  const uow = {
    run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')),
  } as unknown as jest.Mocked<IUnitOfWork>;
  const notifications = { canDeliver: jest.fn().mockReturnValue(true) } as unknown as jest.Mocked<INotificationPort>;
  const otpStore = { probe: jest.fn().mockResolvedValue({ shared: true }) } as jest.Mocked<IOtpStoreProbe>;
  const resendOtp = { execute: jest.fn().mockResolvedValue({ resent: true, cooldownSeconds: 30 }) } as unknown as jest.Mocked<ResendOtpCommand>;
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
  const command = new BootstrapSuperAdminCommand(mfaPolicy, bootstrap, users, hasher, uow, notifications, otpStore, resendOtp, audit);
  return { command, bootstrap, users, hasher, uow, notifications, otpStore, resendOtp, audit };
}

async function refusal(promise: Promise<unknown>): Promise<BootstrapRefusedError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(BootstrapRefusedError);
  return err as BootstrapRefusedError;
}

describe('BootstrapSuperAdminCommand', () => {
  it('creates a PENDING_VERIFICATION Super Admin with a hashed password, global role, marker and audit, atomically', async () => {
    const m = build();
    const result = await m.command.execute({ email: 'Founder@Example.com', password: PASSWORD });

    expect(m.hasher.hash).toHaveBeenCalledWith(PASSWORD);
    expect(m.users.create).toHaveBeenCalledWith(
      {
        phone: null,
        email: 'founder@example.com',
        passwordHash: HASH,
        primaryRole: PrimaryRole.SUPER_ADMIN,
        status: AccountStatus.PENDING_VERIFICATION,
        preferredLanguage: PreferredLanguage.en,
      },
      'tx',
    );
    expect(m.bootstrap.assignSuperAdminRole).toHaveBeenCalledWith('user-1', 'role-sa', 'tx');
    expect(m.bootstrap.markCompleted).toHaveBeenCalledWith('user-1', 'tx');
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, action: 'identity.platform.super_admin_bootstrapped', resourceId: 'user-1' }),
      'tx',
    );
    expect(m.uow.run).toHaveBeenCalledWith(expect.any(Function), { isolation: 'serializable' });
    // Re-checked inside the transaction, not only before it.
    expect(m.bootstrap.inspect).toHaveBeenCalledWith('tx');
    expect(result).toEqual({ userId: 'user-1', maskedEmail: expect.stringContaining('@example.com'), delivery: 'SENT' });
  });

  it('sends exactly one REGISTER code through the normal resend path', async () => {
    const m = build();
    await m.command.execute({ email: 'founder@example.com', password: PASSWORD });
    expect(m.resendOtp.execute).toHaveBeenCalledTimes(1);
    expect(m.resendOtp.execute).toHaveBeenCalledWith({ identifier: 'founder@example.com', purpose: OtpPurpose.REGISTER });
  });

  it('never puts the password or its hash in the audit entry', async () => {
    const m = build();
    await m.command.execute({ email: 'founder@example.com', password: PASSWORD });
    const recorded = JSON.stringify(m.audit.record.mock.calls);
    expect(recorded).not.toContain(PASSWORD);
    expect(recorded).not.toContain(HASH);
    expect(recorded).not.toContain('founder@example.com');
  });

  // Work 66 replaced Work 65's blanket production refusal with these administrator-MFA checks.
  it.each([
    ['MFA enforcement is not active', { ...mfaReady(), enforced: false }, 'MFA_NOT_ENFORCED'],
    ['ADMIN_MFA_ENCRYPTION_KEY is missing', { ...mfaReady(), keyConfigured: false }, 'MFA_KEY_MISSING'],
    ['the MFA migration is not applied', { ...mfaReady(), schemaReady: false }, 'MFA_SCHEMA_MISSING'],
  ])('refuses when %s, before touching anything', async (_label, mfa, reason) => {
    const m = build({ mfa });
    expect((await refusal(m.command.execute({ email: 'a@b.co', password: PASSWORD }))).reason).toBe(reason);
    expect(m.bootstrap.inspect).not.toHaveBeenCalled();
    expect(m.uow.run).not.toHaveBeenCalled();
    expect(m.resendOtp.execute).not.toHaveBeenCalled();
  });

  describe('in production, with the real MFA policy and cipher', () => {
    const productionConfig = (key: string | undefined) =>
      ({
        nodeEnv: 'production',
        isProduction: true,
        get adminMfaEncryptionKey() {
          return key === undefined ? null : Buffer.from(key, 'base64');
        },
      }) as unknown as AppConfigService;
    const policyWith = (config: AppConfigService, schemaReady: boolean) =>
      new AdminMfaPolicy(
        { isSchemaReady: jest.fn().mockResolvedValue(schemaReady) } as unknown as IAdminMfaRepository,
        new AesGcmMfaSecretCipher(config),
      );
    // Test-only key material, generated per run.
    const key = randomBytes(32).toString('base64');

    it('passes the MFA preconditions and creates the Super Admin when the key and migration are in place', async () => {
      const m = build({ mfa: policyWith(productionConfig(key), true) });
      const result = await m.command.execute({ email: 'founder@example.com', password: PASSWORD });
      expect(result.delivery).toBe('SENT');
      expect(m.bootstrap.markCompleted).toHaveBeenCalledTimes(1);
    });

    it('refuses without the encryption key', async () => {
      const m = build({ mfa: policyWith(productionConfig(undefined), true) });
      expect((await refusal(m.command.checkPreconditions())).reason).toBe('MFA_KEY_MISSING');
    });

    it('refuses before the MFA migration is applied', async () => {
      const m = build({ mfa: policyWith(productionConfig(key), false) });
      expect((await refusal(m.command.checkPreconditions())).reason).toBe('MFA_SCHEMA_MISSING');
    });
  });

  it.each([
    ['no SUPER_ADMIN role', { ...ready(), superAdminRole: null }, 'ROLE_CATALOGUE_MISSING'],
    ['no wildcard grant', { ...ready(), superAdminRole: { id: 'r', scope: 'PLATFORM', hasWildcard: false } }, 'ROLE_CATALOGUE_MISSING'],
    ['wrong role scope', { ...ready(), superAdminRole: { id: 'r', scope: 'ORG', hasWildcard: true } }, 'ROLE_CATALOGUE_MISSING'],
    ['marker already consumed', { ...ready(), completed: true }, 'ALREADY_COMPLETED'],
    ['a Super Admin without a marker', { ...ready(), superAdminExists: true }, 'SUPER_ADMIN_EXISTS'],
  ])('refuses with %s and writes nothing', async (_label, state, reason) => {
    const m = build({ state: state as BootstrapInspection });
    expect((await refusal(m.command.execute({ email: 'a@b.co', password: PASSWORD }))).reason).toBe(reason);
    expect(m.users.create).not.toHaveBeenCalled();
    expect(m.uow.run).not.toHaveBeenCalled();
  });

  it('refuses when e-mail is not configured, before any write', async () => {
    const m = build();
    m.notifications.canDeliver.mockReturnValue(false);
    expect((await refusal(m.command.execute({ email: 'a@b.co', password: PASSWORD }))).reason).toBe('EMAIL_NOT_CONFIGURED');
    expect(m.notifications.canDeliver).toHaveBeenCalledWith('EMAIL');
    expect(m.uow.run).not.toHaveBeenCalled();
  });

  it('refuses a process-local or unreachable OTP store', async () => {
    const local = build();
    local.otpStore.probe.mockResolvedValue({ shared: false });
    expect((await refusal(local.command.checkPreconditions())).reason).toBe('OTP_STORE_NOT_SHARED');

    const down = build();
    down.otpStore.probe.mockRejectedValue(IdentityErrors.otpUnavailable());
    expect((await refusal(down.command.checkPreconditions())).reason).toBe('OTP_UNAVAILABLE');
    expect(down.uow.run).not.toHaveBeenCalled();
  });

  it('validates the e-mail, the password policy and e-mail uniqueness before hashing or writing', async () => {
    const m = build();
    expect((await refusal(m.command.execute({ email: 'not-an-email', password: PASSWORD }))).reason).toBe('INVALID_EMAIL');
    const weak = await refusal(m.command.execute({ email: 'a@b.co', password: 'short' }));
    expect(weak.reason).toBe('WEAK_PASSWORD');
    expect(weak.requirements.length).toBeGreaterThan(0);
    expect(weak.message).not.toContain('short');
    m.users.findByEmail.mockResolvedValue({ id: 'someone' } as never);
    expect((await refusal(m.command.execute({ email: 'a@b.co', password: PASSWORD }))).reason).toBe('EMAIL_IN_USE');
    expect(m.hasher.hash).not.toHaveBeenCalled();
    expect(m.uow.run).not.toHaveBeenCalled();
  });

  it('keeps the account and marker when delivery fails, and reports NOT_SENT with the retry delay', async () => {
    const m = build();
    m.resendOtp.execute.mockRejectedValue(IdentityErrors.deliveryUnavailable('EMAIL', 'FAILED', 30));
    const result = await m.command.execute({ email: 'founder@example.com', password: PASSWORD });
    expect(result).toEqual({ userId: 'user-1', maskedEmail: expect.any(String), delivery: 'NOT_SENT', retryAfterSeconds: 30 });
    expect(m.bootstrap.markCompleted).toHaveBeenCalled();
  });

  it('reports a lost race as ALREADY_COMPLETED instead of a database error', async () => {
    const m = build();
    m.uow.run.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    m.bootstrap.inspect.mockResolvedValueOnce(ready()).mockResolvedValueOnce({ ...ready(), completed: true });
    expect((await refusal(m.command.execute({ email: 'a@b.co', password: PASSWORD }))).reason).toBe('ALREADY_COMPLETED');
    expect(m.resendOtp.execute).not.toHaveBeenCalled();
  });

  it('rethrows an unrelated transaction failure', async () => {
    const m = build();
    m.uow.run.mockRejectedValue(new Error('connection lost'));
    await expect(m.command.execute({ email: 'a@b.co', password: PASSWORD })).rejects.toThrow('connection lost');
  });
});
