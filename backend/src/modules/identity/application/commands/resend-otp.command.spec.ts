import { OtpPurpose } from '../../domain/enums';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { INotificationPort } from '../ports/notification.port';
import { IOtpService } from '../ports/otp.service';
import { ResendOtpCommand } from './resend-otp.command';

describe('ResendOtpCommand', () => {
  function build() {
    const otp = {
      issue: jest.fn().mockResolvedValue({ code: '123456', cooldownSeconds: 30 }),
    } as unknown as jest.Mocked<IOtpService>;
    const notifications = {
      send: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<INotificationPort>;
    return { command: new ResendOtpCommand(otp, notifications), otp, notifications };
  }

  // Regression: the reissued OTP must land on the same key as the one it replaces.
  it('issues against the canonical identifier', async () => {
    const { command, otp } = build();

    const result = await command.execute({
      identifier: '0912345678',
      purpose: OtpPurpose.REGISTER,
    });

    expect(otp.issue).toHaveBeenCalledWith('+251912345678', OtpPurpose.REGISTER);
    expect(result).toEqual({ resent: true, cooldownSeconds: 30 });
  });

  it('routes an email identifier over the EMAIL channel', async () => {
    const { command, notifications } = build();

    await command.execute({ identifier: 'User@Example.COM', purpose: OtpPurpose.RESET });

    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'EMAIL',
        to: 'user@example.com',
        template: 'otp-reset',
      }),
    );
  });

  it('rejects a malformed identifier', async () => {
    const { command, otp } = build();

    await expect(
      command.execute({ identifier: 'garbage', purpose: OtpPurpose.REGISTER }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(otp.issue).not.toHaveBeenCalled();
  });
});
