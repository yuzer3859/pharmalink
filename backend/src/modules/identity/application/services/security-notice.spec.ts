import { INotificationPort, NotificationChannel, NotificationUndeliverableError } from '../ports/notification.port';
import { sendSecurityNotice } from './security-notice';

describe('sendSecurityNotice (Work 62)', () => {
  function port(deliverable: NotificationChannel[] = ['EMAIL', 'SMS']) {
    return {
      canDeliver: jest.fn((c: NotificationChannel) => deliverable.includes(c)),
      send: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<INotificationPort>;
  }

  it('goes to the e-mail address first, even when the account also has a phone', async () => {
    const notifications = port();
    expect(await sendSecurityNotice(notifications, { email: 'a@example.com', phone: '+251911234567' }, 'security-password-reset')).toBe('SENT');
    expect(notifications.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'EMAIL', to: 'a@example.com', template: 'security-password-reset', data: { at: expect.any(String) } }),
    );
  });

  it('sends nothing to a phone-only account while SMS cannot deliver', async () => {
    const notifications = port(['EMAIL']);
    expect(await sendSecurityNotice(notifications, { email: null, phone: '+251911234567' }, 'security-password-changed')).toBe('NO_CHANNEL');
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('reports an undelivered notice as FAILED instead of throwing', async () => {
    const notifications = port();
    notifications.send.mockRejectedValue(new NotificationUndeliverableError('EMAIL', 'FAILED'));
    expect(await sendSecurityNotice(notifications, { email: 'a@example.com', phone: null }, 'security-password-changed')).toBe('FAILED');
  });

  it('rethrows anything that is not a delivery failure', async () => {
    const notifications = port();
    notifications.send.mockRejectedValue(new Error('template bug'));
    await expect(sendSecurityNotice(notifications, { email: 'a@example.com', phone: null }, 'x')).rejects.toThrow('template bug');
  });
});
