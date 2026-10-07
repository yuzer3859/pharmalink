import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  INotificationChannelProvider,
} from '../../application/ports/outbound/notification-channel-provider.port';
import { IPushTransport, PUSH_TRANSPORT, PushSendResult } from '../../application/ports/outbound/push-transport.port';
import { PUSH_DELIVERY_POLICY } from '../../domain/delivery-retry-policy';
import { NotificationChannel } from '../../domain/enums';
import { DEVICE_TOKEN_REPOSITORY, IDeviceTokenRepository } from '../../domain/repositories/device-token.repository';
import { withDeadline } from './with-deadline';

/** The FAILED code when the recipient has no active device. */
export const NO_ACTIVE_DEVICE = 'NO_ACTIVE_DEVICE';

/**
 * The PUSH channel provider (module-13 Work 14). One logical delivery per notification — one
 * `notification_delivery_jobs` row, one `delivery_attempts` row per try — fanned out here to the
 * recipient's active devices (at most `maxDevicesPerDelivery`, most recently seen first), all in
 * parallel through `PUSH_TRANSPORT`.
 *
 * How the per-device answers become the one result:
 *
 *     any device accepted it                 → SENT (the first message id); not retried, so a
 *                                              device that got it never gets it twice
 *     else credentials missing / refused     → NOT_CONFIGURED (job waits, no attempt)
 *     else any transient failure / deadline  → FAILED, retryable (Work 13 backoff)
 *     else the request was rejected          → FAILED, not retryable
 *     else every token was dead              → FAILED, not retryable (`FCM_UNREGISTERED`, …)
 *     no active device at all                → FAILED `NO_ACTIVE_DEVICE`, not retryable
 *
 * A token the service reports as permanently invalid is deactivated (only that token), so no
 * later notification tries it. The provider never reads Prisma: tokens come through
 * `DEVICE_TOKEN_REPOSITORY`, the network through `PUSH_TRANSPORT`. Raw tokens are never logged.
 */
@Injectable()
export class PushNotificationProvider implements INotificationChannelProvider {
  readonly name = 'fcm';
  readonly channel = NotificationChannel.PUSH;

  constructor(
    @Inject(DEVICE_TOKEN_REPOSITORY) private readonly tokens: IDeviceTokenRepository,
    @Inject(PUSH_TRANSPORT) private readonly transport: IPushTransport,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(PushNotificationProvider.name);
  }

  async deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    if (!this.transport.isConfigured()) return { outcome: 'NOT_CONFIGURED' };
    const devices = await this.tokens.activeTokensForDelivery(request.recipient.userId, PUSH_DELIVERY_POLICY.maxDevicesPerDelivery);
    if (devices.length === 0) return { outcome: 'FAILED', errorCode: NO_ACTIVE_DEVICE, retryable: false };

    const message = { title: request.title, body: request.body, notificationId: request.notificationId };
    const timedOut: PushSendResult = { kind: 'TRANSIENT', code: 'FCM_TIMEOUT' };
    const results = await Promise.all(
      devices.map((d) =>
        withDeadline(
          this.transport.send(d.token, message, PUSH_DELIVERY_POLICY.requestTimeoutMs).catch((): PushSendResult => ({ kind: 'TRANSIENT', code: 'FCM_NETWORK_ERROR' })),
          PUSH_DELIVERY_POLICY.deliveryDeadlineMs,
          timedOut,
        ),
      ),
    );

    const dead = devices.filter((_, i) => results[i].kind === 'INVALID_TOKEN').map((d) => d.id);
    if (dead.length > 0) {
      try {
        await this.tokens.deactivateByIds(dead);
      } catch {
        // Not fatal to this delivery; the token is reported dead again next time.
        this.logger.warn(`could not deactivate ${dead.length} invalid device token(s)`);
      }
    }

    const sent = results.find((r): r is Extract<PushSendResult, { kind: 'SENT' }> => r.kind === 'SENT');
    if (sent) return { outcome: 'SENT', providerMessageId: sent.messageId ?? undefined };
    if (results.some((r) => r.kind === 'NOT_CONFIGURED')) return { outcome: 'NOT_CONFIGURED' };
    const transient = results.find((r) => r.kind === 'TRANSIENT') as { code: string } | undefined;
    if (transient) return { outcome: 'FAILED', errorCode: transient.code, retryable: true };
    const rejected = results.find((r) => r.kind === 'REJECTED') as { code: string } | undefined;
    if (rejected) return { outcome: 'FAILED', errorCode: rejected.code, retryable: false };
    return { outcome: 'FAILED', errorCode: (results[0] as { code: string }).code, retryable: false };
  }
}
