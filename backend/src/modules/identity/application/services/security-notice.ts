import { INotificationPort, NotificationUndeliverableError } from '../ports/notification.port';

export type SecurityNoticeOutcome = 'SENT' | 'NO_CHANNEL' | 'FAILED';

/**
 * Sends an account-security notice (password changed / reset) after the change has already been
 * made (Work 62). Best effort by design: the change must not be undone, or reported as failed,
 * because a courtesy message could not go out. E-mail first, like registration; a phone-only
 * account gets nothing while SMS has no provider. The outcome goes into the caller's audit record.
 */
export async function sendSecurityNotice(
  notifications: INotificationPort,
  user: { email: string | null; phone: string | null },
  template: string,
): Promise<SecurityNoticeOutcome> {
  const channel = user.email ? 'EMAIL' : 'SMS';
  const to = user.email ?? user.phone;
  if (!to || !notifications.canDeliver(channel)) return 'NO_CHANNEL';
  try {
    await notifications.send({ channel, to, template, data: { at: new Date().toISOString() } });
    return 'SENT';
  } catch (err) {
    if (err instanceof NotificationUndeliverableError) return 'FAILED';
    throw err;
  }
}
