import { AppConfigService } from '../../../../shared/config/app-config.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { RedisService } from '../../../../shared/redis/redis.service';
import { OtpPurpose } from '../../domain/enums';
import { RedisOtpService } from './redis-otp.service';

/**
 * Work 60, without a Redis server: what the adapter sends to Redis and how it fails closed. The
 * atomic behaviour itself (TTLs, single use, attempt limits, cooldown, concurrency, across
 * instances) is proved against a real Redis in `test/identity/redis-otp.e2e-spec.ts`.
 */
describe('RedisOtpService (no server)', () => {
  const SECRET = 'q7Vb2Lx9Rk4Tz1Wm8Np3Hs6Df0Gj5Ya2';
  const PHONE = '+251911223344';

  const config = {
    get: (key: string) => (key === 'OTP_HASH_SECRET' ? SECRET : undefined),
    jwtAccessSecret: 'access-secret-0123456789',
    jwtRefreshSecret: 'refresh-secret-0123456789',
    masterEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
    otpTtlSeconds: 300,
    otpMaxAttempts: 5,
    otpResendCooldownSeconds: 30,
  } as unknown as AppConfigService;

  function build(reply: unknown[] | null) {
    const runScript = jest.fn().mockResolvedValue(reply);
    const redis = {
      isEnabled: true,
      runScript,
      key: (...parts: string[]) => ['pharmalink', ...parts].join(':'),
    } as unknown as RedisService;
    const logger = new AppLogger();
    const logged = jest.fn();
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => logged(...args));
    }
    return { service: new RedisOtpService(redis, config, logger), runScript, logged };
  }

  it('sends only HMACs and namespaced keys to Redis: no code, no raw identifier, no secret', async () => {
    const { service, runScript } = build([1, 30_000]);
    const issued = await service.issue(PHONE, OtpPurpose.REGISTER);
    if (issued.status !== 'ISSUED') throw new Error('expected ISSUED');

    expect(issued.code).toMatch(/^\d{6}$/);
    expect(issued.cooldownSeconds).toBe(30);
    const [, keys, args, timeoutMs] = runScript.mock.calls[0] as [string, string[], string[], number];
    expect(keys[0]).toMatch(/^pharmalink:otp:v1:\{REGISTER:[0-9a-f]{64}\}$/);
    expect(keys[1]).toBe(`${keys[0]}:cooldown`);
    expect(args[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(args.slice(1)).toEqual(['300000', '30000']);
    expect(timeoutMs).toBeGreaterThan(0);
    const sent = JSON.stringify(runScript.mock.calls);
    for (const secretThing of [PHONE, PHONE.slice(1), SECRET, `"${issued.code}"`]) expect(sent).not.toContain(secretThing);
  });

  it('derives the same key for the same identifier and purpose, and different keys otherwise', async () => {
    const { service, runScript } = build(['INVALID']);
    await service.verify(PHONE, OtpPurpose.REGISTER, '000000');
    await service.verify(PHONE, OtpPurpose.REGISTER, '000000');
    await service.verify(PHONE, OtpPurpose.LOGIN, '000000');
    await service.verify('+251911223345', OtpPurpose.REGISTER, '000000');
    const keyOf = (i: number) => (runScript.mock.calls[i][1] as string[])[0];
    const hashOf = (i: number) => (runScript.mock.calls[i][2] as string[])[0];
    expect(keyOf(0)).toBe(keyOf(1));
    expect(hashOf(0)).toBe(hashOf(1));
    expect(new Set([keyOf(0), keyOf(2), keyOf(3)]).size).toBe(3);
    // The same code hashes differently per purpose and identifier, so hashes cannot be replayed
    // between challenges.
    expect(new Set([hashOf(0), hashOf(2), hashOf(3)]).size).toBe(3);
  });

  it('reports a refused issue as COOLDOWN with the remaining seconds', async () => {
    const { service } = build([0, 12_400]);
    expect(await service.issue(PHONE, OtpPurpose.RESET)).toEqual({ status: 'COOLDOWN', retryAfterSeconds: 13 });
  });

  it.each([
    ['Redis unreachable or timed out', null],
    ['a malformed reply', ['MAYBE']],
  ])('fails closed on %s: DEPENDENCY_UNAVAILABLE, never a verification outcome', async (_label, reply) => {
    const { service, logged } = build(reply);
    await expect(service.verify(PHONE, OtpPurpose.LOGIN, '123456')).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      httpStatus: 503,
    });
    await expect(service.issue(PHONE, OtpPurpose.LOGIN)).rejects.toMatchObject({ code: ErrorCode.DEPENDENCY_UNAVAILABLE });
    const logs = JSON.stringify(logged.mock.calls);
    expect(logs).toMatch(/OTP store unavailable/);
    expect(logs).not.toContain('123456');
    expect(logs).not.toContain(PHONE.slice(4));
  });

  it('passes each verification outcome through unchanged', async () => {
    for (const outcome of ['OK', 'INVALID', 'EXPIRED', 'ATTEMPTS_EXCEEDED']) {
      const { service } = build([outcome]);
      expect(await service.verify(PHONE, OtpPurpose.STEP_UP, '123456')).toBe(outcome);
    }
  });
});
