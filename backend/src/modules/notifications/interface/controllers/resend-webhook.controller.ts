import { Controller, HttpCode, HttpStatus, Inject, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { Public } from '../../../identity/interface/decorators/public.decorator';
import {
  EmailDeliveryReportOutcome,
  ProcessEmailDeliveryReportCommand,
} from '../../application/commands/process-email-delivery-report.command';
import { EMAIL_WEBHOOK_READER, IEmailWebhookReader } from '../../application/ports/outbound/email-webhook-reader.port';

/**
 * Resend's e-mail webhooks (module-13 Work 18): `POST /webhooks/resend`. Provider-to-server — no
 * JWT, no RBAC, no user id accepted; authenticity is the Svix signature over the raw body
 * (`rawBody: true` is already set at bootstrap for the payment webhooks), checked behind
 * `EMAIL_WEBHOOK_READER`.
 *
 *  - no `RESEND_WEBHOOK_SECRET` → 503, nothing processed (fails closed; Resend retries later)
 *  - signature, headers or timestamp invalid → 401 `WEBHOOK_SIGNATURE_INVALID`, nothing written
 *  - verified → applied once by `svix-id`; 200 `{ received, outcome }` — the payload is never echoed
 *  - a processing failure propagates as 5xx, so Resend's own retry redelivers it
 */
@Controller('webhooks/resend')
export class ResendWebhookController {
  constructor(
    @Inject(EMAIL_WEBHOOK_READER) private readonly reader: IEmailWebhookReader,
    private readonly process: ProcessEmailDeliveryReportCommand,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: RawBodyRequest<Request>): Promise<{ received: true; outcome: EmailDeliveryReportOutcome }> {
    const headers: Record<string, string | undefined> = {};
    for (const name of ['svix-id', 'svix-timestamp', 'svix-signature']) {
      const v = req.headers[name];
      headers[name] = Array.isArray(v) ? v.join(' ') : v;
    }
    const reading = this.reader.read({ rawBody: req.rawBody, headers });
    if (reading.status === 'NOT_CONFIGURED') throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Webhook receiver is not configured.');
    if (reading.status === 'INVALID_SIGNATURE') {
      throw new ApiException(ErrorCode.WEBHOOK_SIGNATURE_INVALID, 'Webhook signature verification failed.');
    }
    const { outcome } = await this.process.execute(reading.report);
    return { received: true, outcome };
  }
}
