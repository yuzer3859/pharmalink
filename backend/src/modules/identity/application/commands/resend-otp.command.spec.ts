import { OtpPurpose } from '../../domain/enums';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { INotificationPort, NotificationUndeliverableError } from '../ports/notification.port';
import { IOtpService } from '../ports/otp.service';
import { IdentityErrors } from '../../domain/errors';
import { ResendOtpCommand } from './resend-otp.command';

describe('ResendOtpCommand', () => {
  function build() {
    const otp = {
      issue: jest.fn().mockResolvedValue({ status: 'ISSUED', code: '123456', cooldownSeconds: 30 }),
    } as unknown as jest.Mocked<IOtpService>;
    const notifications = {
      canDeliver: jest.fn().mockReturnValue(true),
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

  // Work 60: the store's refusal is final. No code exists, so nothing is sent and no success is
  // reported.
  it('rejects with RATE_LIMITED during the cooldown and sends nothing', async () => {
    const { command, otp, notifications } = build();
    otp.issue.mockResolvedValue({ status: 'COOLDOWN', retryAfterSeconds: 17 });

    await expect(
      command.execute({ identifier: '0912345678', purpose: OtpPurpose.REGISTER }),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED, httpStatus: 429, details: { retryAfterSeconds: 17 } });
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('propagates an unavailable OTP store as DEPENDENCY_UNAVAILABLE and sends nothing', async () => {
    const { command, otp, notifications } = build();
    otp.issue.mockRejectedValue(IdentityErrors.otpUnavailable());

    await expect(
      command.execute({ identifier: '0912345678', purpose: OtpPurpose.REGISTER }),
    ).rejects.toMatchObject({ code: ErrorCode.DEPENDENCY_UNAVAILABLE, httpStatus: 503 });
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('rejects a malformed identifier', async () => {
    const { command, otp } = build();

    await expect(
      command.execute({ identifier: 'garbage', purpose: OtpPurpose.REGISTER }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(otp.issue).not.toHaveBeenCalled();
  });

  // Work 62: success means the provider accepted the message.
  it('refuses an SMS identifier before issuing a code while SMS cannot deliver', async () => {
    const { command, otp, notifications } = build();
    notifications.canDeliver.mockImplementation((channel) => channel !== 'SMS');

    await expect(command.execute({ identifier: '0912345678', purpose: OtpPurpose.LOGIN })).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      httpStatus: 503,
      details: { channel: 'SMS', reason: 'NOT_CONFIGURED' },
    });
    expect(otp.issue).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('refuses an e-mail identifier before issuing a code while e-mail has no provider', async () => {
    const { command, otp, notifications } = build();
    notifications.canDeliver.mockReturnValue(false);

    await expect(command.execute({ identifier: 'user@example.com', purpose: OtpPurpose.REGISTER })).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      details: { channel: 'EMAIL', reason: 'NOT_CONFIGURED' },
    });
    expect(otp.issue).not.toHaveBeenCalled();
  });

  it('reports a failed send as 503 with the cooldown, never as resent, and keeps the code out of the error', async () => {
    const { command, notifications } = build();
    notifications.send.mockRejectedValue(new NotificationUndeliverableError('EMAIL', 'FAILED'));

    const error = await command.execute({ identifier: 'user@example.com', purpose: OtpPurpose.REGISTER }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      httpStatus: 503,
      details: { channel: 'EMAIL', reason: 'FAILED', retryAfterSeconds: 30 },
    });
    expect(JSON.stringify(error)).not.toContain('123456');
    expect(String((error as Error).message)).not.toContain('123456');
  });

  it('does not translate unrelated send failures', async () => {
    const { command, notifications } = build();
    notifications.send.mockRejectedValue(new Error('template bug'));
    await expect(command.execute({ identifier: 'user@example.com', purpose: OtpPurpose.REGISTER })).rejects.toThrow('template bug');
  });
});
