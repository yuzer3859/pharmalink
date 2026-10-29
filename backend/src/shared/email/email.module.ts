import { Global, Module } from '@nestjs/common';
import { EMAIL_TRANSPORT } from './email-transport.port';
import { ResendEmailTransport } from './resend-email.transport';
import { ResendConfig } from './resend.config';

/**
 * The platform's one e-mail transport (Work 62): Resend over its REST API, configured only when
 * `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are both set, and never under `NODE_ENV=test`.
 *
 * Global and below every feature module, so Module 13's delivery queue and Module 01's OTP e-mail
 * share one client and one configuration without depending on each other: Module 13 already
 * imports Module 01, so Module 01 reaching into Module 13 would be a cycle. This module only
 * sends; queueing, retries, webhooks and suppression stay Module 13's.
 */
@Global()
@Module({
  providers: [ResendConfig, { provide: EMAIL_TRANSPORT, useClass: ResendEmailTransport }],
  exports: [ResendConfig, EMAIL_TRANSPORT],
})
export class EmailModule {}
