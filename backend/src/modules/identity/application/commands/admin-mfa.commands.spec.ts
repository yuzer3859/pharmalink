import { randomBytes } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, DevicePlatform, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { hashRecoveryCode, normalizeRecoveryCode } from '../../domain/mfa/recovery-codes';
import { base32Decode, timeStepAt, totpForStep } from '../../domain/mfa/totp';
import {
  AdminMfaChallengeRecord,
  AdminMfaCredentialRecord,
  IAdminMfaRepository,
  NewAdminMfaChallenge,
} from '../../domain/repositories/admin-mfa.repository';
import {
  ILoginHistoryRepository,
  IRefreshTokenRepository,
  ISessionRepository,
} from '../../domain/repositories/auth.repositories';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { AesGcmMfaSecretCipher } from '../../infrastructure/security/aes-gcm-mfa-secret.cipher';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { AdminMfaAuditor } from '../services/admin-mfa-auditor.service';
import { AdminMfaChallengeService, MFA_CHALLENGE_MAX_ATTEMPTS } from '../services/admin-mfa-challenge.service';
import { AuthSessionIssuerService } from '../services/auth-session-issuer.service';
import { PermissionChangeService } from '../services/permission-change.service';
import { ConfirmMfaEnrollmentCommand } from './confirm-mfa-enrollment.command';
import { RedeemMfaRecoveryCodeCommand } from './redeem-mfa-recovery-code.command';
import { RotateMfaRecoveryCodesCommand } from './rotate-mfa-recovery-codes.command';
import { StartMfaEnrollmentCommand } from './start-mfa-enrollment.command';
import { VerifyMfaChallengeCommand } from './verify-mfa-challenge.command';

/** In-memory repository with the same conditional-update semantics as the Prisma adapter. */
class FakeMfaRepository implements IAdminMfaRepository {
  challenges = new Map<string, AdminMfaChallengeRecord & { tokenHash: string }>();
  credentials = new Map<string, AdminMfaCredentialRecord>();
  recoveryCodes: Array<{ userId: string; codeHash: string; usedAt: Date | null }> = [];
  private seq = 0;

  async isPlatformAdministrator(): Promise<boolean> {
    return true;
  }
  async findCredential(userId: string) {
    const c = this.credentials.get(userId);
    return c ? { ...c } : null;
  }
  async createChallenge(data: NewAdminMfaChallenge) {
    const record = { id: `c${++this.seq}`, ...data, encryptedPendingSecret: null, attempts: 0, consumedAt: null };
    this.challenges.set(record.id, record);
    return record;
  }
  async findChallengeByTokenHash(tokenHash: string) {
    const found = [...this.challenges.values()].find((c) => c.tokenHash === tokenHash);
    return found ? { ...found } : null;
  }
  private usable(id: string, now: Date, max: number) {
    const c = this.challenges.get(id);
    return c && !c.consumedAt && c.expiresAt > now && c.attempts < max ? c : null;
  }
  async setPendingSecret(id: string, secret: string, now: Date, max: number) {
    const c = this.usable(id, now, max);
    if (!c || c.purpose !== 'ENROLL') return false;
    c.encryptedPendingSecret = secret;
    return true;
  }
  async registerFailedAttempt(id: string, now: Date, max: number) {
    const c = this.usable(id, now, max);
    if (c) c.attempts += 1;
  }
  async consumeChallenge(id: string, now: Date, max: number) {
    const c = this.usable(id, now, max);
    if (!c) return false;
    c.consumedAt = now;
    return true;
  }
  async advanceTimeStep(userId: string, step: number) {
    const c = this.credentials.get(userId);
    if (!c || (c.lastUsedStep !== null && c.lastUsedStep >= step)) return false;
    c.lastUsedStep = step;
    return true;
  }
  async createCredential(userId: string, encryptedSecret: string, step: number) {
    if (this.credentials.has(userId)) throw new Error('unique violation');
    this.credentials.set(userId, { userId, encryptedSecret, lastUsedStep: step, enabledAt: new Date() });
  }
  async replaceCredential(userId: string, encryptedSecret: string, step: number) {
    this.credentials.set(userId, { userId, encryptedSecret, lastUsedStep: step, enabledAt: new Date() });
  }
  async replaceRecoveryCodes(userId: string, hashes: string[]) {
    this.recoveryCodes = this.recoveryCodes.filter((r) => r.userId !== userId);
    this.recoveryCodes.push(...hashes.map((codeHash) => ({ userId, codeHash, usedAt: null })));
  }
  async consumeRecoveryCode(userId: string, codeHash: string, now: Date) {
    const code = this.recoveryCodes.find((r) => r.userId === userId && r.codeHash === codeHash && !r.usedAt);
    if (!code) return false;
    code.usedAt = now;
    return true;
  }
  async countUnusedRecoveryCodes(userId: string) {
    return this.recoveryCodes.filter((r) => r.userId === userId && !r.usedAt).length;
  }
  async isSchemaReady() {
    return true;
  }
}

function adminUser(): User {
  const now = new Date();
  return User.rehydrate({
    id: 'admin-1',
    phone: null,
    email: 'ops@example.com',
    passwordHash: 'hashed',
    primaryRole: PrimaryRole.ADMIN,
    status: AccountStatus.ACTIVE,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: null,
    emailVerifiedAt: now,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 1,
    deletionRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
}

const deviceInfo = { fingerprint: 'fp-admin', platform: DevicePlatform.WEB };
const SESSION = { accessToken: 'access', accessTokenExpiresAt: 1, refreshToken: 'refresh', refreshTokenExpiresAt: new Date() };

function setup() {
  const repo = new FakeMfaRepository();
  const user = adminUser();
  const users = { findById: jest.fn().mockResolvedValue(user) } as unknown as IUserRepository;
  // Test-only key material, generated per run.
  const cipher = new AesGcmMfaSecretCipher({ adminMfaEncryptionKey: randomBytes(32) } as unknown as AppConfigService);
  const uow = { run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } as unknown as IUnitOfWork;
  // Transactional entries go through AuditService; standalone ones through the retrying auditor.
  const audit = { record: jest.fn() } as unknown as jest.Mocked<AuditService>;
  const auditor = audit as unknown as AdminMfaAuditor;
  const loginHistory = { record: jest.fn(), listForUser: jest.fn() } as jest.Mocked<ILoginHistoryRepository>;
  const sessionIssuer = { issue: jest.fn().mockResolvedValue(SESSION) } as unknown as jest.Mocked<AuthSessionIssuerService>;
  const refreshTokens = { revokeAllForUser: jest.fn() } as unknown as jest.Mocked<IRefreshTokenRepository>;
  const sessions = { revokeAllForUser: jest.fn() } as unknown as jest.Mocked<ISessionRepository>;
  const permissionChange = { propagate: jest.fn() } as unknown as jest.Mocked<PermissionChangeService>;
  const challenges = new AdminMfaChallengeService(repo, loginHistory, sessionIssuer, auditor);

  return {
    repo,
    user,
    audit,
    sessionIssuer,
    refreshTokens,
    permissionChange,
    challenges,
    start: new StartMfaEnrollmentCommand(repo, users, cipher, challenges, auditor),
    confirm: new ConfirmMfaEnrollmentCommand(repo, users, refreshTokens, sessions, cipher, uow, challenges, permissionChange, audit),
    verify: new VerifyMfaChallengeCommand(repo, users, cipher, uow, challenges, audit),
    redeem: new RedeemMfaRecoveryCodeCommand(repo, users, uow, challenges, audit),
    rotate: new RotateMfaRecoveryCodesCommand(repo, cipher, uow, audit, auditor),
  };
}

const codeAt = (secretBase32: string, offsetSteps = 0) =>
  totpForStep(base32Decode(secretBase32), timeStepAt(Date.now()) + offsetSteps);

/** Enrols the admin and returns the authenticator secret and recovery codes. */
async function enrol(m: ReturnType<typeof setup>) {
  const { challenge } = await m.challenges.issue(m.user.id, 'ENROLL');
  const provisioning = await m.start.execute({ challengeToken: challenge.token });
  const code = codeAt(provisioning.secret);
  const result = await m.confirm.execute({ challengeToken: challenge.token, code, deviceInfo });
  return { secret: provisioning.secret, code, recoveryCodes: result.recoveryCodes, provisioning, result };
}

describe('administrator MFA commands (Work 66)', () => {
  describe('enrolment', () => {
    it('stores only ciphertext, issues an MFA-verified session and ten recovery codes stored as hashes', async () => {
      const m = setup();
      const { secret, recoveryCodes, provisioning } = await enrol(m);

      expect(provisioning.otpauthUri).toContain(`secret=${secret}`);
      expect(provisioning).toMatchObject({ issuer: 'PharmaLink', algorithm: 'SHA1', digits: 6, period: 30 });
      const credential = m.repo.credentials.get(m.user.id)!;
      expect(credential.encryptedSecret).not.toContain(secret);
      expect(recoveryCodes).toHaveLength(10);
      expect(m.repo.recoveryCodes.map((r) => r.codeHash)).toEqual(
        recoveryCodes.map((code) => hashRecoveryCode(normalizeRecoveryCode(code)!)),
      );
      expect(JSON.stringify(m.repo.recoveryCodes)).not.toContain(recoveryCodes[0]);
      expect(m.sessionIssuer.issue).toHaveBeenCalledWith(expect.objectContaining({ mfaVerifiedAt: expect.any(Date) }));
    });

    it('never puts the secret, the URI, a code or a challenge token in an audit entry', async () => {
      const m = setup();
      const { secret, recoveryCodes, provisioning } = await enrol(m);
      const audited = JSON.stringify(m.audit.record.mock.calls);
      expect(audited).not.toContain(secret);
      expect(audited).not.toContain(provisioning.otpauthUri);
      for (const code of recoveryCodes) expect(audited).not.toContain(code);
      expect(m.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'identity.mfa.enrollment_completed' }),
        'tx',
      );
    });

    it('refuses to confirm before enrolment was started, and with a wrong code issues nothing', async () => {
      const m = setup();
      const { challenge } = await m.challenges.issue(m.user.id, 'ENROLL');
      await expect(m.confirm.execute({ challengeToken: challenge.token, code: '000000', deviceInfo })).rejects.toMatchObject({
        code: 'AUTH_MFA_CHALLENGE_INVALID',
      });

      const { secret } = await m.start.execute({ challengeToken: challenge.token });
      const wrong = codeAt(secret) === '000000' ? '111111' : '000000';
      await expect(m.confirm.execute({ challengeToken: challenge.token, code: wrong, deviceInfo })).rejects.toMatchObject({
        code: 'AUTH_MFA_CODE_INVALID',
      });
      expect(m.repo.credentials.size).toBe(0);
      expect(m.sessionIssuer.issue).not.toHaveBeenCalled();
    });

    it('does not accept a TOTP challenge for enrolment, or an enrolment challenge for sign-in', async () => {
      const m = setup();
      const verify = await m.challenges.issue(m.user.id, 'VERIFY');
      await expect(m.start.execute({ challengeToken: verify.challenge.token })).rejects.toMatchObject({
        code: 'AUTH_MFA_CHALLENGE_INVALID',
      });
      const enroll = await m.challenges.issue(m.user.id, 'ENROLL');
      await expect(
        m.verify.execute({ challengeToken: enroll.challenge.token, code: '123456', deviceInfo }),
      ).rejects.toMatchObject({ code: 'AUTH_MFA_CHALLENGE_INVALID' });
    });
  });

  describe('sign-in with an authenticator code', () => {
    it('issues an MFA-verified session for a valid code, once', async () => {
      const m = setup();
      const { secret } = await enrol(m);
      m.sessionIssuer.issue.mockClear();

      const { challenge } = await m.challenges.issue(m.user.id, 'VERIFY');
      await m.verify.execute({ challengeToken: challenge.token, code: codeAt(secret, 1), deviceInfo });

      expect(m.sessionIssuer.issue).toHaveBeenCalledTimes(1);
      expect(m.sessionIssuer.issue).toHaveBeenCalledWith(expect.objectContaining({ mfaVerifiedAt: expect.any(Date) }));
      // The challenge is consumed.
      await expect(
        m.verify.execute({ challengeToken: challenge.token, code: codeAt(secret, 1), deviceInfo }),
      ).rejects.toMatchObject({ code: 'AUTH_MFA_CHALLENGE_INVALID' });
    });

    it('refuses an already-accepted time step (the enrolment code) on a new challenge', async () => {
      const m = setup();
      const { code } = await enrol(m);
      const { challenge } = await m.challenges.issue(m.user.id, 'VERIFY');
      await expect(m.verify.execute({ challengeToken: challenge.token, code, deviceInfo })).rejects.toMatchObject({
        code: 'AUTH_MFA_CODE_INVALID',
      });
    });

    it(`kills the challenge after ${MFA_CHALLENGE_MAX_ATTEMPTS} wrong codes, even for a right one afterwards`, async () => {
      const m = setup();
      const { secret } = await enrol(m);
      const { challenge } = await m.challenges.issue(m.user.id, 'VERIFY');
      const right = codeAt(secret, 1);
      const wrong = right === '000000' ? '111111' : '000000';
      for (let i = 0; i < MFA_CHALLENGE_MAX_ATTEMPTS; i += 1) {
        await expect(m.verify.execute({ challengeToken: challenge.token, code: wrong, deviceInfo })).rejects.toMatchObject({
          code: 'AUTH_MFA_CODE_INVALID',
        });
      }
      await expect(m.verify.execute({ challengeToken: challenge.token, code: right, deviceInfo })).rejects.toMatchObject({
        code: 'AUTH_MFA_CHALLENGE_INVALID',
      });
    });

    it('refuses an expired challenge and an unknown token', async () => {
      const m = setup();
      const { secret } = await enrol(m);
      const { challenge } = await m.challenges.issue(m.user.id, 'VERIFY');
      for (const c of m.repo.challenges.values()) c.expiresAt = new Date(Date.now() - 1);
      await expect(
        m.verify.execute({ challengeToken: challenge.token, code: codeAt(secret, 1), deviceInfo }),
      ).rejects.toMatchObject({ code: 'AUTH_MFA_CHALLENGE_INVALID' });
      await expect(
        m.verify.execute({ challengeToken: 'x'.repeat(43), code: codeAt(secret, 1), deviceInfo }),
      ).rejects.toMatchObject({ code: 'AUTH_MFA_CHALLENGE_INVALID' });
    });
  });

  describe('recovery codes', () => {
    it('trades a recovery code for a replacement-enrolment challenge, never a session, and only once', async () => {
      const m = setup();
      const { recoveryCodes } = await enrol(m);
      m.sessionIssuer.issue.mockClear();

      const first = await m.challenges.issue(m.user.id, 'VERIFY');
      const result = await m.redeem.execute({ challengeToken: first.challenge.token, recoveryCode: recoveryCodes[0].toLowerCase() });
      expect(result).toMatchObject({ mfaRequired: true, challenge: { type: 'ENROLLMENT', reason: 'RECOVERY' } });
      expect(result).not.toHaveProperty('accessToken');
      expect(m.sessionIssuer.issue).not.toHaveBeenCalled();

      const second = await m.challenges.issue(m.user.id, 'VERIFY');
      await expect(
        m.redeem.execute({ challengeToken: second.challenge.token, recoveryCode: recoveryCodes[0] }),
      ).rejects.toMatchObject({ code: 'AUTH_MFA_CODE_INVALID' });
    });

    it('replaces the authenticator, revokes old sessions and issues fresh codes on confirmation', async () => {
      const m = setup();
      const { secret: oldSecret, recoveryCodes } = await enrol(m);
      const verify = await m.challenges.issue(m.user.id, 'VERIFY');
      const replacement = await m.redeem.execute({ challengeToken: verify.challenge.token, recoveryCode: recoveryCodes[3] });

      const { secret: newSecret } = await m.start.execute({ challengeToken: replacement.challenge.token });
      expect(newSecret).not.toBe(oldSecret);
      const confirmed = await m.confirm.execute({
        challengeToken: replacement.challenge.token,
        code: codeAt(newSecret),
        deviceInfo,
      });

      expect(confirmed.recoveryCodes).toHaveLength(10);
      expect(confirmed.recoveryCodes).not.toContain(recoveryCodes[0]);
      expect(await m.repo.countUnusedRecoveryCodes(m.user.id)).toBe(10);
      expect(m.refreshTokens.revokeAllForUser).toHaveBeenCalledWith(m.user.id, 'tx');
      expect(m.permissionChange.propagate).toHaveBeenCalledWith([m.user.id]);
      expect(m.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.mfa.authenticator_replaced' }), 'tx');
    });

    it('rotates recovery codes only with a fresh authenticator code', async () => {
      const m = setup();
      const { secret, code, recoveryCodes } = await enrol(m);

      await expect(m.rotate.execute({ userId: m.user.id, code })).rejects.toMatchObject({
        code: 'AUTH_MFA_CODE_INVALID',
      });
      const wrong = codeAt(secret, 1) === '000000' ? '111111' : '000000';
      await expect(m.rotate.execute({ userId: m.user.id, code: wrong })).rejects.toMatchObject({ code: 'AUTH_MFA_CODE_INVALID' });

      const { recoveryCodes: fresh } = await m.rotate.execute({ userId: m.user.id, code: codeAt(secret, 1) });
      expect(fresh).toHaveLength(10);
      expect(fresh).not.toEqual(recoveryCodes);
      expect(m.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'identity.mfa.recovery_codes_rotated' }), 'tx');
      expect(JSON.stringify(m.audit.record.mock.calls)).not.toContain(fresh[0]);
    });
  });
});
