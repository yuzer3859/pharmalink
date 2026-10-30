import { AppConfigService } from '../../../../shared/config/app-config.service';
import { EmailSendResult } from '../../../../shared/email/email-transport.port';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { InMemoryEmailTransport } from '../../../notifications/infrastructure/email/in-memory-email.transport';
import { NotificationUndeliverableError } from '../../application/ports/notification.port';
import { renderIdentityEmail } from './identity-email-templates';
import { IDENTITY_EMAIL_TIMEOUT_MS, IdentityNotificationAdapter } from './identity-notification.adapter';

/**
 * Work 62: Module 01's delivery adapter over the shared e-mail transport. The transport here is
 * the in-memory one (no network); `ResendEmailTransport`'s own HTTP behaviour is covered by
 * Module 13's Resend specs.
 */
describe('IdentityNotificationAdapter', () => {
  const TO = 'abebe@example.com';
  const CODE = '482913';
  let transport: InMemoryEmailTransport;
  let logger: AppLogger;
  let adapter: IdentityNotificationAdapter;

  beforeEach(() => {
    transport = new InMemoryEmailTransport();
    logger = new AppLogger();
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    adapter = new IdentityNotificationAdapter(transport, { otpTtlSeconds: 300 } as AppConfigService, logger);
  });

  afterEach(() => jest.useRealTimers());

  const otp = (template = 'otp-register') => ({ channel: 'EMAIL' as const, to: TO, template, data: { code: CODE } });

  it('sends the OTP e-mail through the shared transport and resolves on SENT', async () => {
    await expect(adapter.send(otp())).resolves.toBeUndefined();
    expect(transport.sent).toHaveLength(1);
    const { message, timeoutMs } = transport.sent[0];
    expect(message.to).toBe(TO);
    expect(message.subject).toBe('Your PharmaLink verification code');
    expect(message.text).toContain(CODE);
    expect(message.text).toContain('expires in 5 minutes');
    expect(message.reference).toMatch(/^identity\/[0-9a-f-]{36}$/);
    expect(timeoutMs).toBe(IDENTITY_EMAIL_TIMEOUT_MS);
  });

  it('uses a fresh reference per message, so a new code is never deduplicated against an old one', async () => {
    await adapter.send(otp());
    await adapter.send(otp());
    expect(transport.sent[0].message.reference).not.toBe(transport.sent[1].message.reference);
  });

  it('can deliver e-mail only when the transport is configured, and SMS never', () => {
    expect(adapter.canDeliver('EMAIL')).toBe(true);
    expect(adapter.canDeliver('SMS')).toBe(false);
    expect(adapter.canDeliver('PUSH')).toBe(false);
    transport.configured = false;
    expect(adapter.canDeliver('EMAIL')).toBe(false);
  });

  it('refuses SMS without touching any transport', async () => {
    await expect(adapter.send({ ...otp(), channel: 'SMS', to: '+251911234567' })).rejects.toEqual(
      new NotificationUndeliverableError('SMS', 'NOT_CONFIGURED'),
    );
    expect(transport.sent).toHaveLength(0);
  });

  it('refuses e-mail when the provider is not configured, without attempting a send', async () => {
    transport.configured = false;
    await expect(adapter.send(otp())).rejects.toMatchObject({ channel: 'EMAIL', reason: 'NOT_CONFIGURED' });
    expect(transport.sent).toHaveLength(0);
  });

  const failures: Array<[string, EmailSendResult | 'THROW' | 'GARBAGE', 'NOT_CONFIGURED' | 'FAILED']> = [
    ['credentials refused', { kind: 'NOT_CONFIGURED' }, 'NOT_CONFIGURED'],
    ['message rejected', { kind: 'REJECTED', code: 'EMAIL_REJECTED' }, 'FAILED'],
    ['invalid recipient', { kind: 'INVALID_RECIPIENT', code: 'EMAIL_INVALID_RECIPIENT' }, 'FAILED'],
    ['provider timeout', { kind: 'TRANSIENT', code: 'EMAIL_TIMEOUT' }, 'FAILED'],
    ['provider outage', { kind: 'TRANSIENT', code: 'EMAIL_UNAVAILABLE' }, 'FAILED'],
    ['transport exception', 'THROW', 'FAILED'],
    ['unrecognised result', 'GARBAGE', 'FAILED'],
  ];

  it.each(failures)('never reports %s as delivered', async (_name, behaviour, reason) => {
    transport.script.set(TO, behaviour);
    await expect(adapter.send(otp())).rejects.toMatchObject({ name: 'NotificationUndeliverableError', channel: 'EMAIL', reason });
  });

  it('bounds a transport that never answers', async () => {
    jest.useFakeTimers();
    transport.script.set(TO, 'HANG');
    const pending = adapter.send(otp());
    const settled = pending.catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(IDENTITY_EMAIL_TIMEOUT_MS + 1_000);
    expect(await settled).toMatchObject({ channel: 'EMAIL', reason: 'FAILED' });
  });

  it('logs a failure with the template and safe result code only: no address, code, text or provider detail', async () => {
    transport.script.set(TO, 'THROW');
    await adapter.send(otp('otp-reset')).catch(() => undefined);
    transport.script.set(TO, { kind: 'REJECTED', code: 'EMAIL_REJECTED' });
    await adapter.send(otp('otp-login')).catch(() => undefined);

    const logged = JSON.stringify([(logger.warn as jest.Mock).mock.calls, (logger.log as jest.Mock).mock.calls]);
    expect(logged).toContain('template=otp-reset result=TRANSIENT/EMAIL_ERROR');
    expect(logged).toContain('template=otp-login result=REJECTED/EMAIL_REJECTED');
    for (const secret of [TO, CODE, 'FAKE_EMAIL_SECRET', 'relay refused', 'PharmaLink code']) expect(logged).not.toContain(secret);
  });

  it('carries no address or code in the error it throws', async () => {
    transport.script.set(TO, 'THROW');
    const error = await adapter.send(otp()).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toMatch(new RegExp(`${CODE}|${TO}`));
    expect((error as Error).message).toBe('EMAIL notification not delivered: FAILED');
  });
});

describe('renderIdentityEmail (Work 62)', () => {
  const ctx = { otpTtlSeconds: 300 };

  it.each([
    ['otp-register', 'Your PharmaLink verification code', 'verify your e-mail address'],
    ['otp-login', 'Your PharmaLink sign-in code', 'finish signing in'],
    ['otp-reset', 'Your PharmaLink password reset code', 'reset your password'],
    ['otp-step_up', 'Your PharmaLink confirmation code', 'confirm this action'],
  ])('%s: code, expiry, single use and security advice, nothing else', (template, subject, purpose) => {
    const { subject: s, text } = renderIdentityEmail(template, { code: '048213' }, ctx);
    expect(s).toBe(subject);
    expect(text).toContain('Your PharmaLink code is 048213');
    expect(text).toContain(purpose);
    expect(text).toContain('It expires in 5 minutes and works once.');
    expect(text).toContain('Do not share it with anyone.');
    expect(text).not.toMatch(/https?:|prescription|pharmacy|Fayda/i);
  });

  it('states the configured lifetime', () => {
    expect(renderIdentityEmail('otp-login', { code: '000001' }, { otpTtlSeconds: 60 }).text).toContain('expires in 1 minute ');
    expect(renderIdentityEmail('otp-login', { code: '000001' }, { otpTtlSeconds: 600 }).text).toContain('expires in 10 minutes');
  });

  it('security notices say when, that sessions were revoked, and what to do; no code', () => {
    const { subject, text } = renderIdentityEmail('security-password-reset', { at: '2026-10-29T07:12:44.000Z' }, ctx);
    expect(subject).toBe('Your PharmaLink password was reset');
    expect(text).toContain('2026-10-29 07:12 UTC');
    expect(text).toContain('signed out of every device');
    expect(text).toContain('reset your password straight away');
    expect(renderIdentityEmail('security-password-changed', { at: 'x' }, ctx).text).toContain('just now');
  });

  it('refuses an unknown template or an OTP template without a six-digit code', () => {
    expect(() => renderIdentityEmail('otp-unknown', { code: '123456' }, ctx)).toThrow(/unknown identity e-mail template/);
    expect(() => renderIdentityEmail('otp-register', {}, ctx)).toThrow(/needs a six-digit code/);
    expect(() => renderIdentityEmail('otp-register', { code: '12345' }, ctx)).toThrow(/needs a six-digit code/);
  });
});
