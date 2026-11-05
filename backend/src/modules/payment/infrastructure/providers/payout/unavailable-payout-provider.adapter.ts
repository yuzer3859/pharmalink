import { Injectable } from '@nestjs/common';
import { PaymentErrors } from '../../../domain/errors';
import {
  IPayoutProviderPort,
  PayoutResult,
} from '../../../application/ports/outbound/payout-provider.port';

/**
 * The production payout rail until a real one is contracted (module-07 Open Question 4). It refuses
 * every call, and `isAvailable()` is false so `ExecutePayoutCommand` refuses before writing anything.
 * The same fail-closed discipline as `TelebirrAdapter`: never quietly substitute a mock for real money.
 */
@Injectable()
export class UnavailablePayoutProvider implements IPayoutProviderPort {
  readonly key = 'none';

  isAvailable(): boolean {
    return false;
  }

  async pay(): Promise<PayoutResult> {
    throw PaymentErrors.paymentProviderUnavailable(this.key, { reason: 'no_payout_rail' });
  }

  async getStatus(): Promise<PayoutResult> {
    throw PaymentErrors.paymentProviderUnavailable(this.key, { reason: 'no_payout_rail' });
  }
}
