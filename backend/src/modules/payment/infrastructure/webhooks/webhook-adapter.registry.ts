import { Injectable } from '@nestjs/common';
import {
  IPaymentWebhookPort,
  IPaymentWebhookRegistry,
} from '../../application/ports/outbound/payment-webhook.port';
import { MockWebhookAdapter } from './mock-webhook.adapter';

/**
 * Selects the webhook adapter for a `{provider}` route segment (§9.2).
 *
 * Adapters are injected and indexed by their own `provider` key, so integrating a real gateway is
 * adding its adapter to this constructor and to the module's providers — no lookup table to keep
 * in sync, and no way for an adapter to be registered under a key it does not answer to.
 *
 * An unknown provider resolves to `null`, and `ProcessWebhookCommand` refuses the delivery. There
 * is deliberately no default adapter: a callback from a gateway we do not recognise is a callback
 * we cannot authenticate.
 */
@Injectable()
export class WebhookAdapterRegistry implements IPaymentWebhookRegistry {
  private readonly adapters: ReadonlyMap<string, IPaymentWebhookPort>;

  constructor(mock: MockWebhookAdapter) {
    // Real Telebirr/bank/card/cross-border webhook adapters join this list in the
    // provider-adapter task, each implementing the same port.
    this.adapters = new Map<string, IPaymentWebhookPort>([[mock.provider, mock]]);
  }

  forProvider(provider: string): IPaymentWebhookPort | null {
    if (typeof provider !== 'string') {
      return null;
    }
    return this.adapters.get(provider.trim().toLowerCase()) ?? null;
  }

  providers(): string[] {
    return [...this.adapters.keys()];
  }
}
