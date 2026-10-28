import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OtpVerifyResult } from '../../application/ports/otp.service';
import { OtpPurpose } from '../../domain/enums';
import { InMemoryOtpService } from './in-memory-otp.service';

/** Work 60: the local/test OTP store follows the same rules as the Redis one, and logs no codes. */
describe('InMemoryOtpService', () => {
  const PHONE = '+251911223344';
  const config = {
    isProduction: false,
    otpTtlSeconds: 300,
    otpMaxAttempts: 3,
    otpResendCooldownSeconds: 30,
  } as unknown as AppConfigService;

  let logged: jest.Mock;
  let service: InMemoryOtpService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-27T09:00:00Z') });
    const logger = new AppLogger();
    logged = jest.fn();
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => logged(...args));
    }
    service = new InMemoryOtpService(config, logger);
  });
  afterEach(() => jest.useRealTimers());

  async function issue(purpose = OtpPurpose.REGISTER, identifier = PHONE): Promise<string> {
    const issued = await service.issue(identifier, purpose);
    if (issued.status !== 'ISSUED') throw new Error('expected ISSUED');
    return issued.code;
  }

  it('issues a six-digit code with the configured cooldown and never logs it', async () => {
    const issued = await service.issue(PHONE, OtpPurpose.REGISTER);
    expect(issued).toEqual({ status: 'ISSUED', code: expect.stringMatching(/^\d{6}$/), cooldownSeconds: 30 });
    expect(logged).not.toHaveBeenCalled();
  });

  it('verifies the right code exactly once', async () => {
    const code = await issue();
    expect(await service.verify(PHONE, OtpPurpose.REGISTER, code)).toBe(OtpVerifyResult.OK);
    expect(await service.verify(PHONE, OtpPurpose.REGISTER, code)).toBe(OtpVerifyResult.EXPIRED);
  });

  it('refuses after the attempt limit, even for the right code', async () => {
    const code = await issue();
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 3; i += 1) expect(await service.verify(PHONE, OtpPurpose.REGISTER, wrong)).toBe(OtpVerifyResult.INVALID);
    expect(await service.verify(PHONE, OtpPurpose.REGISTER, code)).toBe(OtpVerifyResult.ATTEMPTS_EXCEEDED);
  });

  it('expires after the TTL', async () => {
    const code = await issue();
    jest.advanceTimersByTime(300_001);
    expect(await service.verify(PHONE, OtpPurpose.REGISTER, code)).toBe(OtpVerifyResult.EXPIRED);
  });

  it('enforces the resend cooldown, then lets a replacement invalidate the old code', async () => {
    const first = await issue();
    jest.advanceTimersByTime(10_000);
    expect(await service.issue(PHONE, OtpPurpose.REGISTER)).toEqual({ status: 'COOLDOWN', retryAfterSeconds: 20 });
    jest.advanceTimersByTime(20_000);
    let second = await issue();
    // A replacement could draw the same six digits; redraw until it differs, to test invalidation.
    while (second === first) {
      jest.advanceTimersByTime(30_000);
      second = await issue();
    }
    expect(await service.verify(PHONE, OtpPurpose.REGISTER, first)).toBe(OtpVerifyResult.INVALID);
    expect(await service.verify(PHONE, OtpPurpose.REGISTER, second)).toBe(OtpVerifyResult.OK);
  });

  it('isolates challenges by purpose and identifier', async () => {
    const code = await issue(OtpPurpose.REGISTER);
    for (const purpose of [OtpPurpose.LOGIN, OtpPurpose.RESET, OtpPurpose.STEP_UP]) {
      expect(await service.verify(PHONE, purpose, code)).toBe(OtpVerifyResult.EXPIRED);
    }
    expect(await service.verify('+251911223345', OtpPurpose.REGISTER, code)).toBe(OtpVerifyResult.EXPIRED);
    expect(await service.verify(PHONE, OtpPurpose.REGISTER, code)).toBe(OtpVerifyResult.OK);
  });

  it('clear() forgets challenges and cooldowns (test harness reset)', async () => {
    const code = await issue();
    service.clear();
    expect(await service.verify(PHONE, OtpPurpose.REGISTER, code)).toBe(OtpVerifyResult.EXPIRED);
    expect((await service.issue(PHONE, OtpPurpose.REGISTER)).status).toBe('ISSUED');
  });
});
