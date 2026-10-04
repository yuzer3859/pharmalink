import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, OtpPurpose, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IHasher } from '../ports/hasher.port';
import { INotificationPort } from '../ports/notification.port';
import { IOtpService, OtpVerifyResult } from '../ports/otp.service';
import { PermissionChangeService } from '../services/permission-change.service';
import { LogoutAllCommand } from './logout.command';
import { ResetPasswordCommand } from './reset-password.command';

function fakeUser(): User {
  return User.rehydrate({
    id: 'user-1',
    phone: '+251911234567',
    email: null,
    passwordHash: 'old-hash',
    primaryRole: PrimaryRole.CUSTOMER,
    status: AccountStatus.ACTIVE,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: new Date(),
    emailVerifiedAt: null,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 1,
    deletionRequestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

describe('ResetPasswordCommand', () => {
  let users: jest.Mocked<IUserRepository>;
  let otp: jest.Mocked<IOtpService>;
  let hasher: jest.Mocked<IHasher>;
  let notifications: jest.Mocked<INotificationPort>;
  let logoutAll: jest.Mocked<LogoutAllCommand>;
  let permissionChange: jest.Mocked<PermissionChangeService>;
  let audit: jest.Mocked<AuditService>;
  let command: ResetPasswordCommand;

  const validInput = {
    identifier: '0911234567',
    code: '123456',
    newPassword: 'NewPassw0rd',
  };

  beforeEach(() => {
    users = {
      findByIdentifier: jest.fn().mockResolvedValue(fakeUser()),
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IUserRepository>;
    otp = { verify: jest.fn().mockResolvedValue(OtpVerifyResult.OK) } as unknown as jest.Mocked<IOtpService>;
    hasher = { hash: jest.fn().mockResolvedValue('new-hash') } as unknown as jest.Mocked<IHasher>;
    notifications = { send: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<INotificationPort>;
    logoutAll = { execute: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<LogoutAllCommand>;
    permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;

    command = new ResetPasswordCommand(
      users,
      otp,
      hasher,
      notifications,
      logoutAll,
      permissionChange,
      audit,
    );
  });

  it('rotates the credential, kills sessions and alerts the user', async () => {
    const result = await command.execute(validInput);

    expect(otp.verify).toHaveBeenCalledWith('+251911234567', OtpPurpose.RESET, '123456');
    const saved = (users.save.mock.calls[0][0] as User).toProps();
    expect(saved.passwordHash).toBe('new-hash');
    expect(logoutAll.execute).toHaveBeenCalledWith('user-1', 'PASSWORD_RESET');
    expect(permissionChange.propagate).toHaveBeenCalledWith(['user-1']);
    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'security-password-reset' }),
    );
    expect(result).toEqual({ reset: true });
  });

  it.each([
    [OtpVerifyResult.INVALID, ErrorCode.AUTH_OTP_INVALID],
    [OtpVerifyResult.EXPIRED, ErrorCode.AUTH_OTP_EXPIRED],
    [OtpVerifyResult.ATTEMPTS_EXCEEDED, ErrorCode.AUTH_OTP_ATTEMPTS_EXCEEDED],
  ])('maps otp result %s to %s and changes nothing', async (otpResult, expectedCode) => {
    otp.verify.mockResolvedValue(otpResult);

    await expect(command.execute(validInput)).rejects.toMatchObject({ code: expectedCode });
    expect(users.save).not.toHaveBeenCalled();
    expect(logoutAll.execute).not.toHaveBeenCalled();
  });

  it('rejects a weak password after the otp is accepted', async () => {
    await expect(command.execute({ ...validInput, newPassword: 'weak' })).rejects.toMatchObject({
      code: ErrorCode.AUTH_WEAK_PASSWORD,
    });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('reports an unknown user as an invalid code, not as a missing account', async () => {
    users.findByIdentifier.mockResolvedValue(null);

    await expect(command.execute(validInput)).rejects.toMatchObject({
      code: ErrorCode.AUTH_OTP_INVALID,
    });
  });

  it('rejects a malformed identifier without consuming an otp attempt', async () => {
    await expect(
      command.execute({ ...validInput, identifier: 'garbage' }),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_OTP_INVALID });
    expect(otp.verify).not.toHaveBeenCalled();
  });
});
