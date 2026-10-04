import { IConfigPort } from '../../../../shared/config/config.port';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { RawWebhookDelivery, WebhookEventType } from '../../application/webhooks/normalized-webhook-event';
import { computeHmacSignature, verifyHmacSignature } from './hmac-signature';
import {
  MOCK_WEBHOOK_SECRET_KEY,
  MOCK_WEBHOOK_SIGNATURE_HEADER,
  MockWebhookAdapter,
} from './mock-webhook.adapter';
import { WebhookAdapterRegistry } from './webhook-adapter.registry';

const SECRET = 'test-webhook-secret-value';

function configWith(secret: string | undefined): IConfigPort {
  return {
    get: <T = string>(key: string) =>
      (key === MOCK_WEBHOOK_SECRET_KEY ? (secret as unknown as T) : undefined),
    getOrThrow: <T = string>() => undefined as unknown as T,
    isFeatureEnabled: () => false,
  };
}

function signedDelivery(body: unknown, secret = SECRET): RawWebhookDelivery {
  const rawBody = JSON.stringify(body);
  return {
    provider: 'mock',
    rawBody,
    headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: computeHmacSignature(secret, rawBody) },
  };
}

async function expectApiError(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ApiException);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('verifyHmacSignature', () => {
  it('accepts a signature computed over the exact bytes', () => {
    const body = '{"id":"evt-1"}';
    expect(verifyHmacSignature(SECRET, body, computeHmacSignature(SECRET, body))).toBe(true);
  });

  it('rejects a signature over different bytes, and a signature under a different secret', () => {
    const body = '{"id":"evt-1"}';
    expect(verifyHmacSignature(SECRET, body, computeHmacSignature(SECRET, '{"id":"evt-2"}'))).toBe(
      false,
    );
    expect(verifyHmacSignature(SECRET, body, computeHmacSignature('other', body))).toBe(false);
  });

  it('rejects a whitespace-only difference in the body — signatures are over bytes', () => {
    const signature = computeHmacSignature(SECRET, '{"id":"evt-1"}');
    expect(verifyHmacSignature(SECRET, '{ "id":"evt-1" }', signature)).toBe(false);
  });

  it.each([undefined, null, '', 'not-hex', 'a'.repeat(63), 'a'.repeat(65)])(
    'rejects the malformed signature %p without throwing',
    (signature) => {
      expect(() =>
        verifyHmacSignature(SECRET, '{}', signature as string | undefined | null),
      ).not.toThrow();
      expect(verifyHmacSignature(SECRET, '{}', signature as string | undefined | null)).toBe(false);
    },
  );

  it('tolerates surrounding whitespace on an otherwise valid signature', () => {
    const body = '{"id":"evt-1"}';
    expect(verifyHmacSignature(SECRET, body, `  ${computeHmacSignature(SECRET, body)}  `)).toBe(
      true,
    );
  });
});

describe('MockWebhookAdapter — verification (§2)', () => {
  const adapter = new MockWebhookAdapter(configWith(SECRET));

  it('accepts a correctly signed delivery', async () => {
    await expect(adapter.verify(signedDelivery({ id: 'evt-1' }))).resolves.toBeUndefined();
  });

  it('rejects a tampered body', async () => {
    const delivery = signedDelivery({ id: 'evt-1' });
    await expectApiError(
      adapter.verify({ ...delivery, rawBody: '{"id":"evt-1","amount":999999}' }),
      ErrorCode.WEBHOOK_SIGNATURE_INVALID,
    );
  });

  it('rejects a missing signature header', async () => {
    const delivery = signedDelivery({ id: 'evt-1' });
    await expectApiError(
      adapter.verify({ ...delivery, headers: {} }),
      ErrorCode.WEBHOOK_SIGNATURE_INVALID,
    );
  });

  it('fails closed when no secret is configured', async () => {
    const unconfigured = new MockWebhookAdapter(configWith(undefined));
    await expectApiError(
      unconfigured.verify(signedDelivery({ id: 'evt-1' })),
      ErrorCode.WEBHOOK_SIGNATURE_INVALID,
    );
  });

  it('never leaks the secret, the signature or the body in the error', async () => {
    const delivery = signedDelivery({ id: 'evt-1', card: '4111111111111111' });
    try {
      await adapter.verify({ ...delivery, headers: { [MOCK_WEBHOOK_SIGNATURE_HEADER]: 'bad' } });
      throw new Error('expected a rejection');
    } catch (error) {
      const serialized = JSON.stringify({
        message: (error as ApiException).message,
        details: (error as ApiException).details,
      });
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain('4111111111111111');
      expect(serialized).not.toContain('bad');
      expect((error as ApiException).details).toEqual({ provider: 'mock' });
    }
  });
});

describe('MockWebhookAdapter — normalization (§1, §8)', () => {
  const adapter = new MockWebhookAdapter(configWith(SECRET));

  it.each([
    ['payment.authorized', WebhookEventType.AuthorizationSucceeded],
    ['payment.failed', WebhookEventType.AuthorizationFailed],
    ['payment.captured', WebhookEventType.CaptureSucceeded],
  ])('maps %s to %s', async (raw, expected) => {
    const event = await adapter.normalize(
      signedDelivery({ id: 'evt-1', type: raw, paymentId: 'payment-1' }),
    );
    expect(event.type).toBe(expected);
    expect(event.provider).toBe('mock');
    expect(event.eventId).toBe('evt-1');
    expect(event.paymentId).toBe('payment-1');
  });

  it.each(['payment.refunded', 'something.else', undefined, 42])(
    'maps the unrecognised type %p to UNKNOWN rather than guessing',
    async (raw) => {
      const event = await adapter.normalize(
        signedDelivery({ id: 'evt-1', type: raw, paymentId: 'payment-1' }),
      );
      expect(event.type).toBe(WebhookEventType.Unknown);
    },
  );

  it('carries the provider reference and occurredAt through', async () => {
    const event = await adapter.normalize(
      signedDelivery({
        id: 'evt-1',
        type: 'payment.authorized',
        paymentId: 'payment-1',
        providerRef: 'gw-ref-9',
        occurredAt: '2026-09-09T10:00:00.000Z',
      }),
    );
    expect(event.providerRef).toBe('gw-ref-9');
    expect(event.occurredAt.toISOString()).toBe('2026-09-09T10:00:00.000Z');
  });

  it('falls back to now for a missing or invalid occurredAt', async () => {
    for (const occurredAt of [undefined, 'not-a-date']) {
      const event = await adapter.normalize(
        signedDelivery({ id: 'evt-1', type: 'payment.authorized', occurredAt }),
      );
      expect(Number.isNaN(event.occurredAt.getTime())).toBe(false);
    }
  });

  it('sanitizes a failure reason at the boundary it enters the process', async () => {
    const event = await adapter.normalize(
      signedDelivery({
        id: 'evt-1',
        type: 'payment.failed',
        reason: 'Declined for card 4111 1111 1111 1111',
        code: 'do_not_honor',
      }),
    );
    expect(event.failureReason).not.toContain('4111');
    expect(event.failureReason).toContain('[redacted]');
    expect(event.failureCode).toBe('do_not_honor');
  });

  it.each([
    ['unparseable JSON', 'not json'],
    ['a non-object body', '"a string"'],
    ['a missing event id', '{"type":"payment.authorized"}'],
    ['a blank event id', '{"id":"   ","type":"payment.authorized"}'],
  ])('rejects %s as malformed', async (_name, rawBody) => {
    await expectApiError(
      adapter.normalize({ provider: 'mock', rawBody, headers: {} }),
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

describe('WebhookAdapterRegistry', () => {
  const registry = new WebhookAdapterRegistry(new MockWebhookAdapter(configWith(SECRET)));

  it('resolves an integrated gateway, case-insensitively', () => {
    expect(registry.forProvider('mock')?.provider).toBe('mock');
    expect(registry.forProvider('MOCK')?.provider).toBe('mock');
    expect(registry.forProvider('  mock  ')?.provider).toBe('mock');
  });

  it.each(['telebirr', 'unknown', '', 'null'])(
    'returns null for the unintegrated provider %p — there is no default adapter',
    (provider) => {
      expect(registry.forProvider(provider)).toBeNull();
    },
  );

  it('lists the integrated gateways', () => {
    expect(registry.providers()).toEqual(['mock']);
  });
});
