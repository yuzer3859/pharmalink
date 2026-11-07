import { AppConfigService } from '../../../../shared/config/app-config.service';
import { PaymentMethod } from '../../domain/enums';
import { MockPaymentProvider, TEST_DECLINE_TOKEN } from './mock-payment-provider.adapter';

const provider = (isProduction = false) => new MockPaymentProvider({ isProduction } as AppConfigService);
const request = (over: Record<string, unknown> = {}) => ({
  paymentId: 'pay-1',
  orderId: 'order-1',
  amount: 100,
  currency: 'ETB',
  method: PaymentMethod.TELEBIRR,
  ...over,
});

describe('MockPaymentProvider (Work 94)', () => {
  it('is available outside production and never in production', () => {
    expect(provider(false).isAvailable()).toBe(true);
    expect(provider(true).isAvailable()).toBe(false);
  });

  it('declines deterministically for the test token, with a customer-safe reason', async () => {
    const result = await provider().authorize(request({ providerToken: TEST_DECLINE_TOKEN }) as never);
    expect(result).toEqual({
      outcome: 'FAILED',
      providerRef: 'mock-auth-pay-1',
      failureReason: 'Declined by the test gateway.',
      failureCode: 'test_decline',
    });
  });

  it('authorizes any other token, and a return URL still makes it a redirect', async () => {
    expect(await provider().authorize(request({ providerToken: 'tok-ok' }) as never)).toEqual({
      outcome: 'AUTHORIZED',
      providerRef: 'mock-auth-pay-1',
    });
    const pending = await provider().authorize(request({ returnUrl: 'https://app.test/back' }) as never);
    expect(pending).toMatchObject({ outcome: 'PENDING', redirectUrl: 'https://app.test/back?ref=mock-auth-pay-1' });
  });
});
