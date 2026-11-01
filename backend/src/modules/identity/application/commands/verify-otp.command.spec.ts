import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { AccountStatus, DevicePlatform, OtpPurpose, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { User } from '../../domain/entities/user.entity';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { OtpVerifyResult } from '../ports/otp.service';
import { AdminMfaAuditor } from '../services/admin-mfa-auditor.service';
import { AdminMfaPolicy } from '../services/admin-mfa-policy.service';
import { AuthSessionIssuerService } from '../services/auth-session-issuer.service';
import { VerifyOtpCommand } from './verify-otp.command';

function fakeUser(): User {
  const now = new Date();
  return User.rehydrate({
    id: 'user-1',
    phone: '+251912345678',
    email: null,
    passwordHash: 'hashed',
    primaryRole: PrimaryRole.CUSTOMER,
    status: AccountStatus.PENDING_VERIFICATION,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: null,
    emailVerifiedAt: null,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 1,
    deletionRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
}

describe('VerifyOtpCommand', () => {
  function build(verifyResult: OtpVerifyResult, user: User | null = fakeUser(), admin = false) {
    const users = {
      findByIdentifier: jest.fn().mockResolvedValue(user),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as IUserRepository;
    const otp = { verify: jest.fn().mockResolvedValue(verifyResult) };
    const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;
    const sessionIssuer = {
      issue: jest.fn().mockResolvedValue({
        accessToken: 'access',
        accessTokenExpiresAt: 1,
        refreshToken: 'refresh',
        refreshTokenExpiresAt: new Date(),
      }),
    } as unknown as AuthSessionIssuerService;

    const mfaPolicy = { requiresMfa: jest.fn().mockResolvedValue(admin) } as unknown as AdminMfaPolicy;
    const audit = { record: jest.fn() } as unknown as AdminMfaAuditor;

    const command = new VerifyOtpCommand(users, otp as never, outbox, sessionIssuer, mfaPolicy, audit);
    return { command, users, outbox, sessionIssuer, otp, audit };
  }

  // Regression: registration keys the OTP by the stored E.164 phone, so a user submitting the
  // code with the local form they originally typed must still verify against the same key.
  it('verifies the otp against the canonical identifier, not the raw input', async () => {
    const { command, otp, users } = build(OtpVerifyResult.OK);

    await command.execute({
      identifier: '0912345678',
      code: '123456',
      purpose: OtpPurpose.REGISTER,
    });

    expect(otp.verify).toHaveBeenCalledWith('+251912345678', OtpPurpose.REGISTER, '123456');
    expect(users.findByIdentifier).toHaveBeenCalledWith('+251912345678');
  });

  it('rejects a malformed identifier without consuming an otp attempt', async () => {
    const { command, otp } = build(OtpVerifyResult.OK);

    await expect(
      command.execute({ identifier: 'garbage', code: '123456', purpose: OtpPurpose.REGISTER }),
    ).rejects.toMatchObject({ code: 'AUTH_OTP_INVALID' });
    expect(otp.verify).not.toHaveBeenCalled();
  });

  it('verifies phone and activates the account without auto-login by default', async () => {
    const { command, users } = build(OtpVerifyResult.OK);
    const result = await command.execute({
      identifier: '+251912345678',
      code: '123456',
      purpose: OtpPurpose.REGISTER,
    });
    expect(result.verified).toBe(true);
    expect(result.tokens).toBeUndefined();
    expect(users.save).toHaveBeenCalledTimes(1);
  });

  it('auto-logs-in when deviceInfo is supplied on REGISTER', async () => {
    const { command, sessionIssuer } = build(OtpVerifyResult.OK);
    const result = await command.execute({
      identifier: '+251912345678',
      code: '123456',
      purpose: OtpPurpose.REGISTER,
      deviceInfo: { fingerprint: 'fp', platform: DevicePlatform.ANDROID },
    });
    expect(result.tokens?.accessToken).toBe('access');
    expect(sessionIssuer.issue).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid code', async () => {
    const { command } = build(OtpVerifyResult.INVALID);
    await expect(
      command.execute({ identifier: '+251912345678', code: '000000', purpose: OtpPurpose.REGISTER }),
    ).rejects.toMatchObject({ code: 'AUTH_OTP_INVALID' });
  });

  it('rejects an expired code', async () => {
    const { command } = build(OtpVerifyResult.EXPIRED);
    await expect(
      command.execute({ identifier: '+251912345678', code: '000000', purpose: OtpPurpose.REGISTER }),
    ).rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' });
  });

  it('rejects after too many attempts', async () => {
    const { command } = build(OtpVerifyResult.ATTEMPTS_EXCEEDED);
    await expect(
      command.execute({ identifier: '+251912345678', code: '000000', purpose: OtpPurpose.REGISTER }),
    ).rejects.toMatchObject({ code: 'AUTH_OTP_ATTEMPTS_EXCEEDED' });
  });

  describe('platform administrators (Work 66)', () => {
    const deviceInfo = { fingerprint: 'fp-1', platform: DevicePlatform.WEB };

    it.each([OtpPurpose.REGISTER, OtpPurpose.LOGIN])(
      'verifies a %s code but issues no session to an administrator',
      async (purpose) => {
        const user = fakeUser();
        const { command, users, sessionIssuer, audit } = build(OtpVerifyResult.OK, user, true);

        const result = await command.execute({ identifier: '+251912345678', code: '123456', purpose, deviceInfo });

        expect(result).toEqual({ verified: true, mfaRequired: true });
        expect(sessionIssuer.issue).not.toHaveBeenCalled();
        // The code still verified the phone and activated the account.
        expect(users.save).toHaveBeenCalledWith(user);
        expect(user.status).toBe(AccountStatus.ACTIVE);
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'identity.mfa.privileged_session_blocked',
            context: { path: 'OTP_AUTO_LOGIN', purpose },
          }),
        );
      },
    );
  });
});
