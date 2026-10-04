import { Inject, Injectable } from '@nestjs/common';
import {
  IPaymentProviderPort,
  IPaymentProviderRegistry,
  PAYMENT_PROVIDER_PORT,
} from '../../application/ports/outbound/payment-provider.port';
import { PaymentMethod } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { TelebirrAdapter } from './telebirr/telebirr.adapter';

/**
 * The single provider-selection mechanism (§10's Strategy).
 *
 * ## Ordering
 *
 * Real gateways are consulted **before** the default adapter bound to `PAYMENT_PROVIDER_PORT`.
 * That ordering is the whole point: `MockPaymentProvider` supports every gateway method, so if it
 * were consulted first a configured production gateway would never be reached. With real adapters
 * first, `MockPaymentProvider` serves only the methods no configured gateway claims — which is
 * exactly its role as the development/test stand-in (§13).
 *
 * The default slot stays a DI token rather than a hard-coded class so the e2e suites can keep
 * substituting a scripted gateway for it; those doubles flow into this registry unchanged and are
 * resolvable by their own `key`.
 *
 * ## Availability
 *
 * A provider is routable only when `isAvailable()` is absent or true. An adapter whose
 * integration is unimplemented or whose credentials are missing therefore never receives traffic
 * — it does not silently degrade into "method not supported", and it does not get quietly
 * replaced by another gateway. See `TelebirrAdapter`.
 */
@Injectable()
export class PaymentProviderRegistry implements IPaymentProviderRegistry {
  /** Every registered adapter, available or not — `forKey` must be able to explain both. */
  private readonly all: readonly IPaymentProviderPort[];

  constructor(
    @Inject(PAYMENT_PROVIDER_PORT) defaultProvider: IPaymentProviderPort,
    telebirr: TelebirrAdapter,
  ) {
    // Real gateways first, default/stub last. Bank, card and cross-border adapters join this
    // list in their own tasks; nothing else changes.
    this.all = [telebirr, defaultProvider];
  }

  forMethod(method: PaymentMethod): IPaymentProviderPort {
    const provider = this.available().find((candidate) => candidate.supports(method));
    if (!provider) {
      // Reuses the existing method-rejection error so callers see one shape for "no gateway will
      // take this", whether the method is unroutable or every gateway for it is unconfigured.
      throw PaymentErrors.unsupportedPaymentMethod(method, this.availableKeys().join(',') || 'none');
    }
    return provider;
  }

  forKey(providerKey: string | null | undefined): IPaymentProviderPort {
    if (!providerKey) {
      throw PaymentErrors.paymentProviderUnavailable(providerKey ?? null, {
        reason: 'no_provider_recorded',
      });
    }
    const key = providerKey.trim().toLowerCase();
    const provider = this.all.find((candidate) => candidate.key.toLowerCase() === key);
    if (!provider) {
      throw PaymentErrors.paymentProviderUnavailable(providerKey, { reason: 'not_registered' });
    }
    if (!this.isAvailable(provider)) {
      // Deliberately not falling back to another gateway: only the gateway holding this
      // authorization can capture or void it.
      throw PaymentErrors.paymentProviderUnavailable(providerKey, { reason: 'not_available' });
    }
    return provider;
  }

  availableKeys(): string[] {
    return this.available().map((provider) => provider.key);
  }

  private available(): IPaymentProviderPort[] {
    return this.all.filter((provider) => this.isAvailable(provider));
  }

  /** An adapter that does not declare availability is available — the pre-existing contract. */
  private isAvailable(provider: IPaymentProviderPort): boolean {
    return provider.isAvailable ? provider.isAvailable() : true;
  }
}
