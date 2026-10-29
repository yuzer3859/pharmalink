import 'reflect-metadata';
import { randomBytes } from 'crypto';
import { INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RedisService } from '../../src/shared/redis/redis.service';
import { IOtpService, OTP_SERVICE, OtpVerifyResult } from '../../src/modules/identity/application/ports/otp.service';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { InMemoryOtpService } from '../../src/modules/identity/infrastructure/otp/in-memory-otp.service';
import { RedisOtpService } from '../../src/modules/identity/infrastructure/otp/redis-otp.service';

/**
 * Work 61: OTP smoke test for the LOCAL staging stack (ops/staging/README.md). Run in the stack's
 * `tools` image against the stack's own Redis:
 *
 *   docker compose -p pharmalink-staging-rehearsal -f compose.staging.yml --env-file backend/.env.staging \
 *     run --rm tools npx ts-node test/staging/otp-store.smoke.ts
 *
 * It resolves `OTP_SERVICE` through the identity module's real binding (`otpProviders`) on the real
 * config (`validateEnv`), logger and Redis modules — not a second copy of the OTP logic. It does
 * not boot the whole `AppModule`: that would start a second backend (background jobs, outbox relay,
 * event bus) beside the stack's single instance.
 *
 * Codes stay inside this process. Output is only which checks passed; never a code, hash,
 * identifier, secret or connection string. Challenges use a fresh synthetic `.invalid` address
 * and are consumed by the checks; the cooldown keys expire on their own (OTP_RESEND_COOLDOWN_SECONDS).
 * No route is added and no key is deleted. Exits 0 when every check passes, 1 otherwise.
 */
export async function createOtpSmokeContext(): Promise<INestApplicationContext> {
  // Imported here, not at the top: the config module validates the environment as it loads, and an
  // invalid one must become a reported failure (exit 1), not an uncaught error at import time.
  const [{ AppConfigModule }, { LoggingModule }, { RedisModule }, { otpProviders }] = await Promise.all([
    import('../../src/shared/config/config.module'),
    import('../../src/shared/logging/logging.module'),
    import('../../src/shared/redis/redis.module'),
    import('../../src/modules/identity/infrastructure/otp/otp.providers'),
  ]);
  @Module({ imports: [AppConfigModule, LoggingModule, RedisModule], providers: [...otpProviders] })
  class OtpSmokeModule {}
  return NestFactory.createApplicationContext(OtpSmokeModule, { logger: ['error', 'warn'], abortOnError: false });
}

export class SmokeFailure extends Error {}

function check(condition: boolean, message: string): void {
  if (!condition) throw new SmokeFailure(message);
}

async function issuedCode(otp: IOtpService, identifier: string, purpose: OtpPurpose): Promise<string> {
  const outcome = await otp.issue(identifier, purpose);
  check(outcome.status === 'ISSUED', `expected ISSUED for ${purpose}, got ${outcome.status}`);
  return outcome.status === 'ISSUED' ? outcome.code : '';
}

const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

/**
 * Runs the checks against an already-created context and returns the names of those that passed.
 * Throws `SmokeFailure` at the first failed check. Never puts a code in a message.
 */
export async function runOtpSmoke(app: INestApplicationContext, pass: (name: string) => void): Promise<void> {
  const otp = app.get<IOtpService>(OTP_SERVICE);
  const redis = app.get(RedisService);
  check(otp instanceof RedisOtpService && !(otp instanceof InMemoryOtpService), `OTP_SERVICE is ${otp?.constructor?.name}, not RedisOtpService`);
  check(redis.isConnected, 'the shared Redis connection is not ready');
  pass('1. OTP_SERVICE resolves to RedisOtpService (not the in-memory store), Redis connected');

  const identifier = `otp-smoke-${randomBytes(8).toString('hex')}@pharmalink-staging.invalid`;
  const code = await issuedCode(otp, identifier, OtpPurpose.REGISTER);
  check(/^\d{6}$/.test(code), 'issued code is not six digits');
  pass('2. REGISTER challenge issued; six-digit code held in memory only');

  const again = await otp.issue(identifier, OtpPurpose.REGISTER);
  check(again.status === 'COOLDOWN', `immediate re-issue returned ${again.status}, expected COOLDOWN`);
  check(again.status === 'COOLDOWN' && again.retryAfterSeconds > 0, 'COOLDOWN without a positive retryAfterSeconds');
  pass('3. immediate re-issue refused: COOLDOWN');

  const wrong = await otp.verify(identifier, OtpPurpose.REGISTER, wrongCode(code));
  check(wrong === OtpVerifyResult.INVALID, `wrong code returned ${wrong}, expected INVALID`);
  pass('4. wrong code: INVALID');

  const right = await otp.verify(identifier, OtpPurpose.REGISTER, code);
  check(right === OtpVerifyResult.OK, `correct code returned ${right}, expected OK`);
  pass('5. correct code: OK');

  const replay = await otp.verify(identifier, OtpPurpose.REGISTER, code);
  check(replay === OtpVerifyResult.EXPIRED, `replay returned ${replay}, expected EXPIRED`);
  pass('6. replay of the consumed code: EXPIRED');

  // Another purpose with a live challenge of its own must reject the REGISTER code. A different
  // purpose is tried in the one-in-a-million case that its code equals the REGISTER code.
  let isolated = false;
  for (const purpose of [OtpPurpose.LOGIN, OtpPurpose.RESET, OtpPurpose.STEP_UP]) {
    const own = await issuedCode(otp, identifier, purpose);
    if (own === code) continue;
    const crossed = await otp.verify(identifier, purpose, code);
    check(crossed === OtpVerifyResult.INVALID, `${purpose} accepted or mis-handled the REGISTER code: ${crossed}, expected INVALID`);
    // Its own code still verifies, so the rejected attempt did not consume it; this also leaves no
    // live challenge behind.
    const ownResult = await otp.verify(identifier, purpose, own);
    check(ownResult === OtpVerifyResult.OK, `${purpose} own code returned ${ownResult}, expected OK`);
    isolated = true;
    pass(`7. ${purpose} challenge rejects the REGISTER code (INVALID) and still accepts its own (OK)`);
    break;
  }
  check(isolated, 'could not issue a distinct code for another purpose');
}

export async function main(): Promise<number> {
  let app: INestApplicationContext | undefined;
  const passed: string[] = [];
  try {
    app = await createOtpSmokeContext();
    await runOtpSmoke(app, (name) => {
      passed.push(name);
      console.log(`PASS ${name}`);
    });
    console.log(`OTP SMOKE PASSED (${passed.length}/7 checks)`);
    return 0;
  } catch (err) {
    // A SmokeFailure message is ours and code-free. Anything else (config validation, Redis) is
    // reported by type and message only; neither carries a secret value (validateEnv and
    // assertOtpHashSecret never echo values).
    const message = err instanceof Error ? err.message : String(err);
    console.error(`OTP SMOKE FAILED after ${passed.length} passing check(s): ${message}`);
    return 1;
  } finally {
    await app?.close();
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
