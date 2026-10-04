import { IConfigPort } from '../../../../shared/config/config.port';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  IPaymentProviderPort,
  ProviderAuthorizationResult,
  ProviderCaptureResult,
  ProviderRefundResult,
  ProviderVoidResult,
} from '../../application/ports/outbound/payment-provider.port';
import { PaymentMethod } from '../../domain/enums';
import { MockPaymentProvider } from './mock-payment-provider.adapter';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { TelebirrAdapter } from './telebirr/telebirr.adapter';
import { TelebirrConfig, TELEBIRR_CONFIG_KEYS } from './telebirr/telebirr.config';

function configWith(values: Record<string, string> = {}): IConfigPort {
  return {
    get: <T = string>(key: string) => values[key] as unknown as T | undefined,
    getOrThrow: <T = string>() => undefined as unknown as T,
    isFeatureEnabled: () => false,
  };
}

/** A stand-in for a future real gateway: available, and claiming one method. */
class StubGateway implements IPaymentProviderPort {
  constructor(
    readonly key: string,
    private readonly methods: PaymentMethod[],
    private readonly available = true,
  ) {}
  supports(method: PaymentMethod): boolean {
    return this.methods.includes(method);
  }
  isAvailable(): boolean {
    return this.available;
  }
  async authorize(): Promise<ProviderAuthorizationResult> {
    return { outcome: 'AUTHORIZED', providerRef: `${this.key}-ref` };
  }
  async capture(): Promise<ProviderCaptureResult> {
    return { outcome: 'CAPTURED', providerRef: `${this.key}-cap` };
  }
  async voidAuthorization(): Promise<ProviderVoidResult> {
    return { outcome: 'VOIDED', providerRef: `${this.key}-void` };
  }
  async refund(): Promise<ProviderRefundResult> {
    return { outcome: 'REFUNDED', providerRef: `${this.key}-refund` };
  }
}

/** An adapter from before availability existed — it omits `isAvailable` entirely. */
class LegacyGateway implements IPaymentProviderPort {
  readonly key = 'legacy';
  supports(): boolean {
    return true;
  }
  async authorize(): Promise<ProviderAuthorizationResult> {
    return { outcome: 'AUTHORIZED', providerRef: 'legacy-ref' };
  }
  async capture(): Promise<ProviderCaptureResult> {
    return { outcome: 'CAPTURED', providerRef: null };
  }
  async voidAuthorization(): Promise<ProviderVoidResult> {
    return { outcome: 'VOIDED', providerRef: null };
  }
  async refund(): Promise<ProviderRefundResult> {
    return { outcome: 'REFUNDED', providerRef: null };
  }
}

function registryWith(
  defaultProvider: IPaymentProviderPort,
  telebirrConfig: Record<string, string> = {},
): PaymentProviderRegistry {
  return new PaymentProviderRegistry(
    defaultProvider,
    new TelebirrAdapter(new TelebirrConfig(configWith(telebirrConfig))),
  );
}

function expectApiError(fn: () => unknown, code: ErrorCode): ApiException {
  expect(fn).toThrow(ApiException);
  try {
    fn();
    throw new Error('expected a throw');
  } catch (error) {
    expect((error as ApiException).code).toBe(code);
    return error as ApiException;
  }
}

describe('PaymentProviderRegistry — resolution by method', () => {
  it('resolves the mock provider for the gateway methods it serves', () => {
    const registry = registryWith(new MockPaymentProvider());

    for (const method of [
      PaymentMethod.TELEBIRR,
      PaymentMethod.CARD,
      PaymentMethod.BANK_TRANSFER,
      PaymentMethod.CROSS_BORDER,
    ]) {
      expect(registry.forMethod(method).key).toBe('mock');
    }
  });

  it.each([PaymentMethod.COD, PaymentMethod.WALLET])(
    'refuses %s — no gateway authorizes it',
    (method) => {
      const registry = registryWith(new MockPaymentProvider());
      const error = expectApiError(
        () => registry.forMethod(method),
        ErrorCode.VALIDATION_ERROR,
      );
      expect(error.details).toMatchObject({ field: 'method', method });
    },
  );

  it('prefers an available real gateway over the default stand-in', () => {
    // Ordering matters: the mock supports every gateway method, so if it were consulted first a
    // configured production gateway would never receive traffic.
    const real = new StubGateway('real-telebirr', [PaymentMethod.TELEBIRR]);
    const registry = new PaymentProviderRegistry(new MockPaymentProvider(), real as never);

    expect(registry.forMethod(PaymentMethod.TELEBIRR).key).toBe('real-telebirr');
    // Methods the real gateway does not claim still fall through to the stand-in.
    expect(registry.forMethod(PaymentMethod.CARD).key).toBe('mock');
  });

  it('skips an unavailable gateway rather than routing to it', () => {
    const unavailable = new StubGateway('offline', [PaymentMethod.TELEBIRR], false);
    const registry = new PaymentProviderRegistry(new MockPaymentProvider(), unavailable as never);

    expect(registry.forMethod(PaymentMethod.TELEBIRR).key).toBe('mock');
    expect(registry.availableKeys()).not.toContain('offline');
  });

  it('treats an adapter that declares no availability as available', () => {
    const registry = registryWith(new LegacyGateway());
    expect(registry.forMethod(PaymentMethod.CARD).key).toBe('legacy');
    expect(registry.availableKeys()).toContain('legacy');
  });

  it('excludes Telebirr from routing while its integration is unavailable', () => {
    const configured = {
      [TELEBIRR_CONFIG_KEYS.enabled]: 'true',
      [TELEBIRR_CONFIG_KEYS.baseUrl]: 'https://example.invalid',
      [TELEBIRR_CONFIG_KEYS.merchantId]: 'merchant',
      [TELEBIRR_CONFIG_KEYS.apiSecret]: 'secret',
      [TELEBIRR_CONFIG_KEYS.webhookSecret]: 'webhook-secret',
    };
    // Even fully configured, the contract is not implemented, so it must not receive traffic.
    const registry = registryWith(new MockPaymentProvider(), configured);

    expect(registry.availableKeys()).toEqual(['mock']);
    expect(registry.forMethod(PaymentMethod.TELEBIRR).key).toBe('mock');
  });
});

describe('PaymentProviderRegistry — resolution by recorded key', () => {
  it('resolves the gateway a payment was authorized through', () => {
    const registry = registryWith(new MockPaymentProvider());
    expect(registry.forKey('mock').key).toBe('mock');
    expect(registry.forKey('MOCK').key).toBe('mock');
    expect(registry.forKey('  mock  ').key).toBe('mock');
  });

  it.each([null, undefined, ''])('refuses a payment with no recorded provider (%p)', (key) => {
    const registry = registryWith(new MockPaymentProvider());
    const error = expectApiError(
      () => registry.forKey(key as string | null | undefined),
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
    expect(error.details).toMatchObject({ reason: 'no_provider_recorded' });
  });

  it('refuses an unregistered gateway rather than substituting another', () => {
    const registry = registryWith(new MockPaymentProvider());
    const error = expectApiError(
      () => registry.forKey('some-gateway-we-removed'),
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
    expect(error.details).toMatchObject({ reason: 'not_registered' });
  });

  it('refuses a registered but unavailable gateway — only it can capture its own authorization', () => {
    // This is the case that matters: a payment authorized through Telebirr must never be captured
    // through the mock because Telebirr is offline.
    const registry = registryWith(new MockPaymentProvider());
    const error = expectApiError(
      () => registry.forKey('telebirr'),
      ErrorCode.DEPENDENCY_UNAVAILABLE,
    );
    expect(error.details).toMatchObject({ provider: 'telebirr', reason: 'not_available' });
  });

  it('lists only usable gateways', () => {
    expect(registryWith(new MockPaymentProvider()).availableKeys()).toEqual(['mock']);
  });

  it('never leaks a credential value through a resolution error', () => {
    const registry = registryWith(new MockPaymentProvider(), {
      [TELEBIRR_CONFIG_KEYS.apiSecret]: 'super-secret-value',
      [TELEBIRR_CONFIG_KEYS.webhookSecret]: 'super-secret-webhook',
    });
    try {
      registry.forKey('telebirr');
      throw new Error('expected a throw');
    } catch (error) {
      const serialized = JSON.stringify({
        message: (error as ApiException).message,
        details: (error as ApiException).details,
      });
      expect(serialized).not.toContain('super-secret-value');
      expect(serialized).not.toContain('super-secret-webhook');
    }
  });
});
