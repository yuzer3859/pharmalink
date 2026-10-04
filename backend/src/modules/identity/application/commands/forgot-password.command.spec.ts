import { AuditService } from '../../../../shared/audit/audit.service';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, OtpPurpose, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { INotificationPort } from '../ports/notification.port';
import { IOtpService } from '../ports/otp.service';
import { ForgotPasswordCommand } from './forgot-password.command';

function fakeUser(): User {
  return User.rehydrate({
    id: 'user-1',
    phone: '+251911234567',
    email: null,
    passwordHash: 'hash',
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

describe('ForgotPasswordCommand', () => {
  let users: jest.Mocked<IUserRepository>;
  let otp: jest.Mocked<IOtpService>;
  let notifications: jest.Mocked<INotificationPort>;
  let audit: jest.Mocked<AuditService>;
  let command: ForgotPasswordCommand;

  beforeEach(() => {
    users = { findByIdentifier: jest.fn().mockResolvedValue(fakeUser()) } as unknown as jest.Mocked<IUserRepository>;
    otp = {
      issue: jest.fn().mockResolvedValue({ code: '123456', cooldownSeconds: 60 }),
    } as unknown as jest.Mocked<IOtpService>;
    notifications = { send: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<INotificationPort>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    command = new ForgotPasswordCommand(users, otp, notifications, audit);
  });

  it('issues a RESET otp to a known identifier', async () => {
    const result = await command.execute({ identifier: '0911234567' });

    expect(result).toEqual({ challengeSent: true });
    expect(otp.issue).toHaveBeenCalledWith('+251911234567', OtpPurpose.RESET);
    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'SMS', template: 'otp-reset' }),
    );
  });

  it('normalizes the identifier to E.164 before lookup', async () => {
    await command.execute({ identifier: '0911234567' });
    expect(users.findByIdentifier).toHaveBeenCalledWith('+251911234567');
  });

  it('reports success for an unknown identifier without issuing an otp', async () => {
    users.findByIdentifier.mockResolvedValue(null);

    const result = await command.execute({ identifier: 'nobody@example.com' });

    expect(result).toEqual({ challengeSent: true });
    expect(otp.issue).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('reports success for a malformed identifier, revealing nothing', async () => {
    const result = await command.execute({ identifier: 'not-a-phone-or-email' });

    expect(result).toEqual({ challengeSent: true });
    expect(users.findByIdentifier).not.toHaveBeenCalled();
    expect(otp.issue).not.toHaveBeenCalled();
  });

  it('audits the attempt with a masked identifier only', async () => {
    await command.execute({ identifier: '0911234567' });

    const entry = audit.record.mock.calls[0][0];
    expect(entry.action).toBe('identity.password.reset_requested');
    expect(JSON.stringify(entry.context)).not.toContain('+251911234567');
    expect(JSON.stringify(entry.context)).toContain('****');
  });
});
