import { Injectable } from '@nestjs/common';
import { EmailSendResult, IEmailTransport } from '../../application/ports/outbound/email-transport.port';

/**
 * Production's e-mail transport until a provider is approved (module-13 Work 16): never configured,
 * sends nothing, makes no network call, reads no configuration. With it bound, the e-mail provider
 * is not registered and EMAIL delivery jobs wait `PENDING` — Work 13's "no provider" behaviour —
 * ready to go out the day a real transport replaces it.
 */
@Injectable()
export class UnconfiguredEmailTransport implements IEmailTransport {
  readonly name = 'email-unconfigured';

  isConfigured(): boolean {
    return false;
  }

  async send(): Promise<EmailSendResult> {
    return { kind: 'NOT_CONFIGURED' };
  }
}
