import { randomUUID } from 'crypto';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { EventNotifications, NotificationIntent } from './support/event-notifications';

class RecordingRepository implements Pick<INotificationRepository, 'insertIfAbsent'> {
  rows: NewNotification[] = [];
  async insertIfAbsent(n: NewNotification): Promise<boolean> {
    if (this.rows.some((r) => r.dedupeKey === n.dedupeKey)) return false;
    this.rows.push(n);
    return true;
  }
}

/**
 * Module 13 Work 08's application layer. The wallet events name their user, so this is Work 01's
 * direct path — no recipient port — with Module 01's language port behind a fake.
 */
describe('Wallet notifications (application)', () => {
  const USER = 'user-a';
  let repo: RecordingRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let record: RecordNotificationCommand;

  beforeEach(() => {
    repo = new RecordingRepository();
    languages = { [USER]: PreferredLanguage.en };
    record = new RecordNotificationCommand(repo as unknown as INotificationRepository, {
      preferredLanguageOf: async (id) => languages[id] ?? null,
    } satisfies IIdentityLanguageReadPort);
  });

  const movement = { userId: USER, amount: 12_550 };

  type Case = [string, (p: typeof movement) => NotificationIntent, NotificationTemplateCode, string, string];
  const cases: Case[] = [
    ['wallet.credited', EventNotifications.walletCredited, NotificationTemplateCode.WALLET_CREDITED, 'Wallet credited', 'Your PharmaLink wallet has been credited with 125.50 ETB.'],
    ['wallet.debited', EventNotifications.walletDebited, NotificationTemplateCode.WALLET_DEBITED, 'Wallet debited', '125.50 ETB has been deducted from your PharmaLink wallet.'],
  ];

  const run = (c: Case, eventId = randomUUID(), payload: object = movement) =>
    record.execute({ eventId, eventType: c[0], intent: c[1](payload as typeof movement) });

  it.each(cases)('%s → the event’s own user, the right template, amount and currency only', async (...c) => {
    const [eventType, , templateCode, title, body] = c;
    const eventId = randomUUID();
    expect(await run(c, eventId)).toEqual({ created: true, language: 'en' });
    expect(repo.rows).toEqual([
      {
        recipientUserId: USER,
        category: NotificationCategory.TRANSACTIONAL,
        channel: NotificationChannel.IN_APP,
        templateCode,
        eventType,
        dedupeKey: `${eventId}:${USER}`,
        data: { amount: 12_550, currency: 'ETB' },
        title,
        body,
        status: NotificationStatus.SENT,
      },
    ]);
  });

  it.each(cases)('%s keeps nothing else the event or a careless producer might carry', async (...c) => {
    await run(c, randomUUID(), {
      ...movement,
      balance: 999_999,
      ledgerReference: 'WALLET-TOPUP-secret',
      paymentId: 'payment-secret',
      providerToken: 'tok_live_secret',
      accountId: 'acct-secret',
    });
    expect(Object.keys(repo.rows[0].data).sort()).toEqual(['amount', 'currency']);
    const raw = JSON.stringify(repo.rows[0]);
    // No bare digits here: they could occur in the random dedupe key. The keys check covers `balance`.
    for (const leaked of ['balance', 'WALLET-TOPUP-secret', 'payment-secret', 'tok_live_secret', 'acct-secret']) {
      expect({ leaked, found: raw.includes(leaked) }).toEqual({ leaked, found: false });
    }
  });

  it.each(cases)('%s wording is a wallet movement — never income, a transfer, a payout or a balance', (...c) => {
    for (const language of ['en', 'am'] as const) {
      const r = renderNotification(c[2], language, { amount: 12_550, currency: 'ETB' });
      expect(`${r.title} ${r.body}`).not.toMatch(/income|profit|revenue|bank|transfer|payout|balance|earn/i);
    }
  });

  it('renders in Amharic for an Amharic-speaking user', async () => {
    languages[USER] = PreferredLanguage.am;
    expect(await run(cases[0])).toEqual({ created: true, language: 'am' });
    expect(repo.rows[0]).toMatchObject({ title: 'ወደ ዋሌትዎ ገንዘብ ገብቷል', body: 'ወደ ፋርማሊንክ ዋሌትዎ 125.50 ETB ገብቷል።' });
    languages[USER] = PreferredLanguage.am;
    await run(cases[1]);
    expect(repo.rows[1]).toMatchObject({ title: 'ከዋሌትዎ ገንዘብ ተቀንሷል', body: 'ከፋርማሊንክ ዋሌትዎ 125.50 ETB ተቀንሷል።' });
  });

  it.each([[null], [undefined], ['aa']])('falls back to English for language %p', async (language) => {
    languages[USER] = language as PreferredLanguage | null;
    expect((await run(cases[1])).language).toBe('en');
    expect(repo.rows[0].title).toBe('Wallet debited');
  });

  it('an unknown user still gets English and the event’s own recipient — none is invented or swapped', async () => {
    const stranger = 'user-not-in-module-01';
    await record.execute({ eventId: randomUUID(), eventType: 'wallet.credited', intent: EventNotifications.walletCredited({ userId: stranger, amount: 100 }) });
    expect(repo.rows[0]).toMatchObject({ recipientUserId: stranger, title: 'Wallet credited' });
  });

  it.each(cases)('%s redelivered is recorded once, keyed eventId:userId', async (...c) => {
    const eventId = randomUUID();
    expect((await run(c, eventId)).created).toBe(true);
    expect((await run(c, eventId)).created).toBe(false);
    expect(repo.rows.map((r) => r.dedupeKey)).toEqual([`${eventId}:${USER}`]);
  });
});
