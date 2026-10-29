import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { EMAIL_TRANSPORT, EmailSendResult, IEmailTransport } from '../../../../shared/email/email-transport.port';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  INotificationPort,
  NotificationChannel,
  NotificationRequest,
  NotificationUndeliverableError,
} from '../../application/ports/notification.port';
import { renderIdentityEmail } from './identity-email-templates';

/** How long one OTP e-mail may take before the request reports it undelivered. */
export const IDENTITY_EMAIL_TIMEOUT_MS = 8_000;

const RESULT_KINDS = new Set<EmailSendResult['kind']>(['SENT', 'INVALID_RECIPIENT', 'TRANSIENT', 'REJECTED', 'NOT_CONFIGURED']);

/**
 * Module 01's delivery adapter (Work 62): e-mail through the platform's shared transport
 * (`EMAIL_TRANSPORT`, Resend), sent while the request waits. SMS has no provider yet, so it is
 * never deliverable; when one is approved, this is the one place that learns about it.
 *
 * - **Synchronous, not queued.** The code goes straight to the provider; nothing is written to the
 *   outbox, Module 13's delivery jobs or any table, so no OTP is ever at rest outside the hashed store.
 * - **Truthful.** `send` resolves only on the provider's `SENT`. Anything else — not configured,
 *   refused, rejected, a timeout (bounded here even if a transport hangs), an exception or a reply
 *   it doesn't recognise — rejects with `NotificationUndeliverableError`. No fallback to logging.
 * - **Nothing sensitive in logs.** A failure logs the template and the provider's safe result code;
 *   never the address, the code, the message text or a provider response.
 *
 * Module 13's suppression list is not consulted: it belongs to Module 13, which depends on this
 * module. A user-requested code to a suppressed address is attempted and may bounce.
 */
@Injectable()
export class IdentityNotificationAdapter implements INotificationPort {
  constructor(
    @Inject(EMAIL_TRANSPORT) private readonly email: IEmailTransport,
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(IdentityNotificationAdapter.name);
  }

  canDeliver(channel: NotificationChannel): boolean {
    return channel === 'EMAIL' && this.email.isConfigured();
  }

  async send(request: NotificationRequest): Promise<void> {
    if (!this.canDeliver(request.channel)) {
      throw new NotificationUndeliverableError(request.channel, 'NOT_CONFIGURED');
    }
    const { subject, text } = renderIdentityEmail(request.template, request.data, {
      otpTtlSeconds: this.config.otpTtlSeconds,
    });

    const result = await this.attempt(() =>
      this.email.send({ to: request.to, subject, text, reference: `identity/${randomUUID()}` }, IDENTITY_EMAIL_TIMEOUT_MS),
    );
    if (result.kind === 'SENT') return;

    this.logger.warn(
      `Identity e-mail not delivered: template=${request.template} result=${result.kind}${'code' in result ? `/${result.code}` : ''}`,
    );
    throw new NotificationUndeliverableError('EMAIL', result.kind === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'FAILED');
  }

  /** The transport's result, or a safe stand-in when it throws, hangs or answers nonsense. */
  private async attempt(send: () => Promise<EmailSendResult>): Promise<EmailSendResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<EmailSendResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'TRANSIENT', code: 'EMAIL_TIMEOUT' }), IDENTITY_EMAIL_TIMEOUT_MS + 1_000);
      timer.unref();
    });
    try {
      const result = await Promise.race([send(), timeout]);
      return result && RESULT_KINDS.has(result.kind) ? result : { kind: 'TRANSIENT', code: 'EMAIL_INVALID_RESULT' };
    } catch {
      return { kind: 'TRANSIENT', code: 'EMAIL_ERROR' };
    } finally {
      clearTimeout(timer);
    }
  }
}
