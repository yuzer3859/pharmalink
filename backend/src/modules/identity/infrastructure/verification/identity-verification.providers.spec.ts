import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { validateEnv } from '../../../../shared/config/env.validation';
import { ENCRYPTION_PORT } from '../../../../shared/crypto/crypto.port';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { SubmitFaydaVerificationCommand } from '../../application/commands/submit-fayda-verification.command';
import {
  IDENTITY_VERIFICATION_PROVIDER,
  IIdentityVerificationProvider,
} from '../../application/ports/identity-verification.provider';
import { USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { CONSENT_REPOSITORY, VERIFICATION_REPOSITORY } from '../../domain/repositories/verification.repository';
import { FAYDA_VERIFICATION_PROVIDER, identityVerificationProviders } from './identity-verification.providers';
import { MockFaydaProvider } from './mock-fayda.provider';

/**
 * Dependency-injection tests for the identity module's verification-provider selection (Work 58,
 * ADR-027). They compile the module's real bindings (`identityVerificationProviders`) in a Nest
 * testing module, so the factory, the composition-boundary token and the mock's own guard all run
 * exactly as they do in `IdentityModule`.
 *
 * The "real provider" below is a **test-only fake** implementing `IIdentityVerificationProvider`.
 * Passing these tests proves the wiring accepts a real adapter and fails closed without one; it is
 * **not** evidence that Fayda verification works — no Fayda integration exists.
 */
const BASE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'access-secret-0123456789',
  JWT_REFRESH_SECRET: 'refresh-secret-0123456789',
  MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  // Production also requires the Redis OTP store's settings (Work 60). Never connected to here.
  REDIS_URL: 'redis://localhost:6379',
  OTP_HASH_SECRET: 'q7Vb2Lx9Rk4Tz1Wm8Np3Hs6Df0Gj5Ya2',
};

/**
 * An `AppConfigService` over a fixed environment. `validated: false` deliberately skips
 * `validateEnv`, to prove the composition layer refuses a bad selection even if validation were
 * bypassed (defence in depth).
 */
function configFor(env: Record<string, string>, { validated = true } = {}): AppConfigService {
  const values: Record<string, unknown> = validated ? { ...validateEnv({ ...BASE_ENV, ...env }) } : { ...BASE_ENV, ...env };
  const nodeEnv = (values.NODE_ENV as string | undefined) ?? 'development';
  return {
    get: <T>(key: string) => values[key] as T | undefined,
    get nodeEnv() {
      return nodeEnv;
    },
    get isProduction() {
      return nodeEnv === 'production';
    },
    get isTest() {
      return nodeEnv === 'test';
    },
  } as unknown as AppConfigService;
}

class FakeRealFaydaProvider implements IIdentityVerificationProvider {
  async verifyFayda() {
    return { matched: false, failureReason: 'test fake' };
  }
}

async function compile(config: AppConfigService, real?: IIdentityVerificationProvider) {
  let builder = Test.createTestingModule({
    providers: [{ provide: AppConfigService, useValue: config }, AppLogger, ...identityVerificationProviders],
  });
  if (real) builder = builder.overrideProvider(FAYDA_VERIFICATION_PROVIDER).useValue(real);
  return builder.compile();
}

describe('identity verification provider wiring (DI)', () => {
  beforeEach(() => {
    jest.spyOn(AppLogger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('1. a supported non-production configuration selects the mock', async () => {
    const envs: Array<Record<string, string>> = [{ NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { NODE_ENV: 'development', IDENTITY_VERIFICATION_PROVIDER: 'mock' }];
    for (const env of envs) {
      const moduleRef = await compile(configFor(env));
      expect(moduleRef.get(IDENTITY_VERIFICATION_PROVIDER)).toBeInstanceOf(MockFaydaProvider);
    }
  });

  it('2. an invalid or contradictory selection is rejected by validation and, if bypassed, by composition', async () => {
    expect(() => configFor({ NODE_ENV: 'development', IDENTITY_VERIFICATION_PROVIDER: 'real' })).toThrow(/IDENTITY_VERIFICATION_PROVIDER/);
    expect(() => configFor({ NODE_ENV: 'production', IDENTITY_VERIFICATION_PROVIDER: 'mock' })).toThrow(/not allowed in production/);
    await expect(compile(configFor({ NODE_ENV: 'development', IDENTITY_VERIFICATION_PROVIDER: 'real' }, { validated: false }))).rejects.toThrow(
      /must be one of mock, fayda/,
    );
  });

  it('3. production with the mock selected fails at startup, and the mock is never constructed', async () => {
    const constructed = jest.spyOn(AppLogger.prototype, 'setContext');
    await expect(compile(configFor({ NODE_ENV: 'production', IDENTITY_VERIFICATION_PROVIDER: 'mock' }, { validated: false }))).rejects.toThrow(
      /IDENTITY_VERIFICATION_PROVIDER=mock is not allowed in production/,
    );
    await expect(compile(configFor({ NODE_ENV: 'production' }, { validated: false }))).rejects.toThrow(/must be set explicitly in production/);
    expect(constructed).not.toHaveBeenCalledWith(MockFaydaProvider.name);
  });

  it('4. production requesting fayda with no real adapter registered fails at startup with an explanation', async () => {
    await expect(compile(configFor({ NODE_ENV: 'production', IDENTITY_VERIFICATION_PROVIDER: 'fayda' }))).rejects.toThrow(
      /IDENTITY_VERIFICATION_PROVIDER=fayda, but no real IIdentityVerificationProvider is registered.*the mock is never substituted/s,
    );
  });

  it('5. production + fayda with a provider supplied at the composition boundary wires it into the use case (test fake; wiring only)', async () => {
    const fake = new FakeRealFaydaProvider();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: AppConfigService, useValue: configFor({ NODE_ENV: 'production', IDENTITY_VERIFICATION_PROVIDER: 'fayda' }) },
        AppLogger,
        ...identityVerificationProviders,
        SubmitFaydaVerificationCommand,
        { provide: VERIFICATION_REPOSITORY, useValue: {} },
        { provide: CONSENT_REPOSITORY, useValue: {} },
        { provide: USER_REPOSITORY, useValue: {} },
        { provide: ENCRYPTION_PORT, useValue: {} },
        { provide: AuditService, useValue: {} },
      ],
    })
      .overrideProvider(FAYDA_VERIFICATION_PROVIDER)
      .useValue(fake)
      .compile();

    expect(moduleRef.get(IDENTITY_VERIFICATION_PROVIDER)).toBe(fake);
    // The unchanged domain use case receives the supplied adapter through its existing token.
    const command = moduleRef.get(SubmitFaydaVerificationCommand);
    expect((command as unknown as { provider: IIdentityVerificationProvider }).provider).toBe(fake);
  });

  it('6. the mock provider keeps its own production guard', () => {
    expect(() => new MockFaydaProvider(configFor({ NODE_ENV: 'production', IDENTITY_VERIFICATION_PROVIDER: 'fayda' }), new AppLogger())).toThrow(
      /MockFaydaProvider must not be used in production/,
    );
    expect(() => new MockFaydaProvider(configFor({ NODE_ENV: 'development' }), new AppLogger())).not.toThrow();
  });

  it('7. selecting fayda never falls back to the mock, in any mode', async () => {
    await expect(compile(configFor({ NODE_ENV: 'development', IDENTITY_VERIFICATION_PROVIDER: 'fayda' }))).rejects.toThrow(
      /no real IIdentityVerificationProvider is registered/,
    );
    const fake = new FakeRealFaydaProvider();
    const moduleRef = await compile(configFor({ NODE_ENV: 'development', IDENTITY_VERIFICATION_PROVIDER: 'fayda' }), fake);
    const selected = moduleRef.get(IDENTITY_VERIFICATION_PROVIDER);
    expect(selected).toBe(fake);
    expect(selected).not.toBeInstanceOf(MockFaydaProvider);
  });
});
