import {
  INotificationPort,
  NotificationChannel,
  NotificationRequest,
  NotificationUndeliverableError,
} from '../../src/modules/identity/application/ports/notification.port';

/**
 * Test double for the SMS/email port. Keeps outbound delivery mocked (no provider credentials
 * anywhere in the suite) while letting tests read the OTP the system actually issued — the same
 * way a user reads it off their phone. This exercises the real OTP service and the real
 * notification contract; only the transport is faked.
 *
 * Every channel is deliverable by default, so specs that register by phone keep exercising the
 * SMS-shaped flows. A spec can mark a channel `unavailable` (no provider) or make sends `fail`
 * (provider refused) to exercise the Work 62 delivery rules; `clear()` restores the defaults.
 */
export class RecordingNotificationAdapter implements INotificationPort {
  readonly sent: NotificationRequest[] = [];
  readonly unavailable = new Set<NotificationChannel>();
  readonly failing = new Set<NotificationChannel>();

  canDeliver(channel: NotificationChannel): boolean {
    return !this.unavailable.has(channel);
  }

  async send(request: NotificationRequest): Promise<void> {
    if (this.unavailable.has(request.channel)) throw new NotificationUndeliverableError(request.channel, 'NOT_CONFIGURED');
    if (this.failing.has(request.channel)) throw new NotificationUndeliverableError(request.channel, 'FAILED');
    this.sent.push(request);
  }

  clear(): void {
    this.sent.length = 0;
    this.unavailable.clear();
    this.failing.clear();
  }

  /** Most recent notification delivered to `to`, optionally filtered by template. */
  lastFor(to: string, template?: string): NotificationRequest | undefined {
    return [...this.sent]
      .reverse()
      .find((n) => n.to === to && (template === undefined || n.template === template));
  }

  /** The most recent OTP code sent to `to`. Throws loudly so tests fail with a clear reason. */
  lastCodeFor(to: string, template?: string): string {
    const notification = this.lastFor(to, template);
    if (!notification) {
      const seen = this.sent.map((n) => `${n.template}->${n.to}`).join(', ') || 'none';
      throw new Error(`No notification was sent to ${to}. Delivered so far: ${seen}`);
    }
    const code = notification.data?.code;
    if (typeof code !== 'string') {
      throw new Error(`Notification ${notification.template} to ${to} carried no OTP code.`);
    }
    return code;
  }
}
