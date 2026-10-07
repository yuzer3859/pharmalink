import { Injectable } from '@nestjs/common';
import { ISmsTransport, SmsSendResult } from '../../application/ports/outbound/sms-transport.port';

/**
 * Production's SMS transport until a gateway is approved (module-13 Work 15): never configured,
 * sends nothing, makes no network call. With it bound, the SMS provider is not registered and SMS
 * delivery jobs wait `PENDING` — Work 13's "no provider" behaviour — ready to go out the day a real
 * transport replaces it. It reads no configuration: there are no SMS credentials to read yet.
 */
@Injectable()
export class UnconfiguredSmsTransport implements ISmsTransport {
  readonly name = 'sms-unconfigured';

  isConfigured(): boolean {
    return false;
  }

  async send(): Promise<SmsSendResult> {
    return { kind: 'NOT_CONFIGURED' };
  }
}
