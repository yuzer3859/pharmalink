import { EmailMessage, EmailSendResult, IEmailTransport } from '../../application/ports/outbound/email-transport.port';

export type InMemoryEmailBehaviour = EmailSendResult | 'THROW' | 'HANG' | 'GARBAGE';

/**
 * **NON-PRODUCTION.** A deterministic, in-process e-mail provider for tests (module-13 Work 16). It
 * performs no network I/O and mails no one: it records what it was asked to send and answers with
 * the scripted result for that address (default: `SENT`). Not bound by `NotificationsModule`.
 */
export class InMemoryEmailTransport implements IEmailTransport {
  readonly name = 'email-in-memory';
  configured = true;
  readonly sent: Array<{ message: EmailMessage; timeoutMs: number }> = [];
  readonly script = new Map<string, InMemoryEmailBehaviour>();

  isConfigured(): boolean {
    return this.configured;
  }

  async send(message: EmailMessage, timeoutMs: number): Promise<EmailSendResult> {
    this.sent.push({ message, timeoutMs });
    const behaviour = this.script.get(message.to) ?? { kind: 'SENT', messageId: `email-${this.sent.length}` };
    if (behaviour === 'THROW') throw new Error(`relay refused ${message.to} token=FAKE_EMAIL_SECRET`);
    if (behaviour === 'HANG') return new Promise(() => undefined);
    if (behaviour === 'GARBAGE') return { kind: 'MAYBE', raw: message.to } as unknown as EmailSendResult;
    return behaviour;
  }
}
