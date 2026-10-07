/**
 * Resend smoke test (module-13 Work 17) — OPT-IN, MANUAL, sends ONE real e-mail.
 *
 * Not part of any test suite: Jest never picks it up (no `.spec` / `.e2e-spec` suffix) and it is
 * not wired to any npm script. It exercises the production `ResendEmailTransport` — the same
 * request, idempotency key, timeout and error mapping the delivery queue uses — without the app,
 * the database or any customer data.
 *
 * Required environment (nothing is defaulted, nothing is printed):
 *
 *   RESEND_API_KEY      a Resend API key with sending access
 *   RESEND_FROM_EMAIL   a sender on a domain verified in Resend, e.g. "PharmaLink <alerts@your-domain>"
 *   RESEND_SMOKE_TO     YOUR OWN test inbox — never a customer address
 *   RESEND_SMOKE_LANG   optional: en (default) or am
 *
 * Run from backend/ (NODE_ENV must not be "test" — the transport refuses to send under test):
 *
 *   RESEND_API_KEY=... RESEND_FROM_EMAIL=... RESEND_SMOKE_TO=... npx ts-node test/manual/resend-smoke.ts
 *
 * It sends the ACCOUNT_REACTIVATED notification's rendered title and body ("Account reactivated" /
 * "Your account is active again.") — a safe transactional message with no personal or medical
 * content — and prints only the outcome, the Resend message id and a masked recipient.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { IConfigPort } from '../../src/shared/config/config.port';
import { AppLogger } from '../../src/shared/logging/app-logger.service';
import { emailContentOf } from '../../src/modules/notifications/domain/email-content';
import { EMAIL_DELIVERY_POLICY } from '../../src/modules/notifications/domain/delivery-retry-policy';
import { NotificationTemplateCode, renderNotification } from '../../src/modules/notifications/domain/templates';
import { ResendEmailTransport } from '../../src/modules/notifications/infrastructure/email/resend-email.transport';
import { RESEND_CONFIG_KEYS, ResendConfig } from '../../src/modules/notifications/infrastructure/email/resend.config';

const mask = (address: string) => address.replace(/^(.{0,2})[^@]*@/, '$1***@');

async function main(): Promise<number> {
  const to = process.env.RESEND_SMOKE_TO?.trim();
  const missing = [RESEND_CONFIG_KEYS.apiKey, RESEND_CONFIG_KEYS.fromEmail, 'RESEND_SMOKE_TO'].filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(`Not sending: missing ${missing.join(', ')}.`);
    return 2;
  }
  if (process.env.NODE_ENV === 'test') {
    console.error('Not sending: NODE_ENV=test (the transport never sends under test).');
    return 2;
  }

  const env: IConfigPort = { get: <T>(k: string) => process.env[k] as T | undefined, getOrThrow: <T>(k: string) => process.env[k] as T, isFeatureEnabled: () => false };
  const transport = new ResendEmailTransport(new ResendConfig(env), new AppLogger());
  const language = process.env.RESEND_SMOKE_LANG === 'am' ? 'am' : 'en';
  const { subject, text } = emailContentOf(renderNotification(NotificationTemplateCode.ACCOUNT_REACTIVATED, language, {}));

  const result = await transport.send({ to: to!, subject, text, reference: `smoke-${randomUUID()}` }, EMAIL_DELIVERY_POLICY.requestTimeoutMs);
  console.log(JSON.stringify({ to: mask(to!), language, result }));
  return result.kind === 'SENT' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error('Smoke test crashed.');
    process.exit(1);
  },
);
