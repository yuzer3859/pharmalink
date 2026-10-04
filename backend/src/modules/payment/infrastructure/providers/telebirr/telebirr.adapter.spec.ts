import { IConfigPort } from '../../../../../shared/config/config.port';
import { ApiException } from '../../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../../shared/errors/error-codes';
import { PaymentMethod } from '../../../domain/enums';
import { TelebirrWebhookAdapter } from '../../webhooks/telebirr-webhook.adapter';
import { TelebirrAdapter, TELEBIRR_MISSING_CONTRACT } from './telebirr.adapter';
import { TelebirrConfig, TELEBIRR_CONFIG_KEYS } from './telebirr.config';

const FULL_CONFIG = {
  [TELEBIRR_CONFIG_KEYS.enabled]: 'true',
  [TELEBIRR_CONFIG_KEYS.baseUrl]: 'https://telebirr.example.invalid',
  [TELEBIRR_CONFIG_KEYS.merchantId]: 'merchant-123',
  [TELEBIRR_CONFIG_KEYS.apiSecret]: 'api-secret-never-logged',
  [TELEBIRR_CONFIG_KEYS.webhookSecret]: 'webhook-secret-never-logged',
};

function configWith(values: Record<string, string> = {}): TelebirrConfig {
  const port: IConfigPort = {
    get: <T = string>(key: string) => values[key] as unknown as T | undefined,
    getOrThrow: <T = string>() => undefined as unknown as T,
    isFeatureEnabled: () => false,
  };
  return new TelebirrConfig(port);
}

async function expectUnavailable(promise: Promise<unknown>): Promise<ApiException> {
  await expect(promise).rejects.toBeInstanceOf(ApiException);
  try {
    await promise;
    throw new Error('expected a rejection');
  } catch (error) {
    expect((error as ApiException).code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    return error as ApiException;
  }
}

describe('TelebirrConfig', () => {
  it('reports the gateway as disabled and incomplete when nothing is set', () => {
    expect(configWith().describe()).toEqual({
      enabled: false,
      missing: [
        TELEBIRR_CONFIG_KEYS.baseUrl,
        TELEBIRR_CONFIG_KEYS.merchantId,
        TELEBIRR_CONFIG_KEYS.apiSecret,
        TELEBIRR_CONFIG_KEYS.webhookSecret,
      ],
      complete: false,
    });
  });

  it('reports complete only when enabled and every key is present', () => {
    expect(configWith(FULL_CONFIG).describe()).toEqual({
      enabled: true,
      missing: [],
      complete: true,
    });
  });

  it('is not enabled by a value other than "true"', () => {
    for (const value of ['1', 'yes', 'TRUE ', '']) {
      const state = configWith({ ...FULL_CONFIG, [TELEBIRR_CONFIG_KEYS.enabled]: value }).describe();
      expect(state.enabled).toBe(value.trim().toLowerCase() === 'true');
    }
  });

  it('treats a blank value as missing', () => {
    const state = configWith({ ...FULL_CONFIG, [TELEBIRR_CONFIG_KEYS.apiSecret]: '   ' }).describe();
    expect(state.missing).toEqual([TELEBIRR_CONFIG_KEYS.apiSecret]);
    expect(state.complete).toBe(false);
  });

  it('describe() exposes key names only, never values', () => {
    const serialized = JSON.stringify(
      configWith({ ...FULL_CONFIG, [TELEBIRR_CONFIG_KEYS.apiSecret]: '' }).describe(),
    );
    expect(serialized).toContain(TELEBIRR_CONFIG_KEYS.apiSecret);
    expect(serialized).not.toContain('webhook-secret-never-logged');
    expect(serialized).not.toContain('merchant-123');
  });
});

describe('TelebirrAdapter — method scope (§10)', () => {
  const adapter = new TelebirrAdapter(configWith(FULL_CONFIG));

  it('claims TELEBIRR only', () => {
    expect(adapter.supports(PaymentMethod.TELEBIRR)).toBe(true);
  });

  it.each([
    PaymentMethod.CARD,
    PaymentMethod.BANK_TRANSFER,
    PaymentMethod.CROSS_BORDER,
    PaymentMethod.COD,
    PaymentMethod.WALLET,
  ])('does not claim %s — nothing in the design says Telebirr handles it', (method) => {
    expect(adapter.supports(method)).toBe(false);
  });

  it('uses the stable provider key that is persisted on Payment.provider', () => {
    expect(adapter.key).toBe('telebirr');
  });
});

describe('TelebirrAdapter — unavailable while the provider contract is missing', () => {
  it('is unavailable even when fully configured', () => {
    // Configuration is not the blocker; the absent integration contract is.
    expect(new TelebirrAdapter(configWith(FULL_CONFIG)).isAvailable()).toBe(false);
    expect(new TelebirrAdapter(configWith()).isAvailable()).toBe(false);
  });

  it.each([
    ['authorize', (a: TelebirrAdapter) => a.authorize()],
    ['capture', (a: TelebirrAdapter) => a.capture()],
    ['voidAuthorization', (a: TelebirrAdapter) => a.voidAuthorization()],
  ])('refuses %s rather than simulating a result', async (operation, call) => {
    const adapter = new TelebirrAdapter(configWith(FULL_CONFIG));

    const error = await expectUnavailable(call(adapter));

    expect(error.details).toMatchObject({
      provider: 'telebirr',
      operation,
      reason: 'provider_contract_unavailable',
    });
    // The gap is enumerated in the error, so it is actionable at the point of failure.
    expect((error.details as { missingContract: string[] }).missingContract.length).toBeGreaterThan(
      0,
    );
  });

  it('reports the missing configuration keys by name when unconfigured', async () => {
    const adapter = new TelebirrAdapter(configWith());

    const error = await expectUnavailable(adapter.capture());

    expect(error.details).toMatchObject({
      enabled: false,
      missingConfigKeys: [
        TELEBIRR_CONFIG_KEYS.baseUrl,
        TELEBIRR_CONFIG_KEYS.merchantId,
        TELEBIRR_CONFIG_KEYS.apiSecret,
        TELEBIRR_CONFIG_KEYS.webhookSecret,
      ],
    });
  });

  it('never leaks a credential through an error, even when fully configured', async () => {
    const adapter = new TelebirrAdapter(configWith(FULL_CONFIG));

    const error = await expectUnavailable(adapter.authorize());

    const serialized = JSON.stringify({ message: error.message, details: error.details });
    expect(serialized).not.toContain('api-secret-never-logged');
    expect(serialized).not.toContain('webhook-secret-never-logged');
    expect(serialized).not.toContain('merchant-123');
    expect(serialized).not.toContain('telebirr.example.invalid');
  });

  it('does not delegate to any other provider (§12)', () => {
    // The one failure mode that must never exist: a "Telebirr adapter" that quietly answers with
    // a mock's result would be indistinguishable from a working integration until real money.
    const source = String(TelebirrAdapter)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    expect(source).not.toMatch(/Mock|mockProvider|delegate/i);
    expect(source).not.toMatch(/outcome:\s*'(AUTHORIZED|CAPTURED|VOIDED)'/);
  });

  it('enumerates the provider facts still required', () => {
    expect(TELEBIRR_MISSING_CONTRACT).toEqual(
      expect.arrayContaining([
        expect.stringContaining('API base URLs'),
        expect.stringContaining('authentication scheme'),
        expect.stringContaining('callback signature algorithm'),
        expect.stringContaining('idempotency'),
      ]),
    );
  });
});

describe('TelebirrWebhookAdapter — unavailable while the callback contract is missing', () => {
  it('is unavailable and refuses verification rather than guessing a signature scheme', async () => {
    const adapter = new TelebirrWebhookAdapter(configWith(FULL_CONFIG));

    expect(adapter.isAvailable()).toBe(false);
    const error = await expectUnavailable(adapter.verify());
    expect(error.details).toMatchObject({ provider: 'telebirr', operation: 'verify' });
  });

  it('refuses normalization rather than guessing an event vocabulary', async () => {
    const adapter = new TelebirrWebhookAdapter(configWith(FULL_CONFIG));
    const error = await expectUnavailable(adapter.normalize());
    expect(error.details).toMatchObject({ operation: 'normalize' });
  });

  it('never echoes the secret, the signature or the raw body in its error', async () => {
    const adapter = new TelebirrWebhookAdapter(configWith(FULL_CONFIG));
    try {
      await adapter.verify();
      throw new Error('expected a rejection');
    } catch (error) {
      const serialized = JSON.stringify({
        message: (error as ApiException).message,
        details: (error as ApiException).details,
      });
      expect(serialized).not.toContain('webhook-secret-never-logged');
      expect(serialized).not.toContain('whatever');
      expect(serialized).not.toContain('evt-1');
    }
  });

  it('uses the same provider key as the outbound adapter', () => {
    expect(new TelebirrWebhookAdapter(configWith()).provider).toBe('telebirr');
  });
});
