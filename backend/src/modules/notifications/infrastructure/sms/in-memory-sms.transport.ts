import { ISmsTransport, SmsSendResult } from '../../application/ports/outbound/sms-transport.port';

export type InMemorySmsBehaviour = SmsSendResult | 'THROW' | 'HANG' | 'GARBAGE';

/**
 * **NON-PRODUCTION.** A deterministic, in-process SMS gateway for tests (module-13 Work 15). It
 * performs no network I/O and texts no one: it records what it was asked to send and answers with
 * the scripted result for that destination (default: `SENT`). Not bound by `NotificationsModule`.
 */
export class InMemorySmsTransport implements ISmsTransport {
  readonly name = 'sms-in-memory';
  configured = true;
  readonly sent: Array<{ to: string; text: string; timeoutMs: number }> = [];
  readonly script = new Map<string, InMemorySmsBehaviour>();

  isConfigured(): boolean {
    return this.configured;
  }

  async send(to: string, text: string, timeoutMs: number): Promise<SmsSendResult> {
    this.sent.push({ to, text, timeoutMs });
    const behaviour = this.script.get(to) ?? { kind: 'SENT', messageId: `sms-${this.sent.length}` };
    if (behaviour === 'THROW') throw new Error(`gateway exploded for ${to} token=FAKE_SMS_SECRET`);
    if (behaviour === 'HANG') return new Promise(() => undefined);
    if (behaviour === 'GARBAGE') return { kind: 'MAYBE', raw: `${to}` } as unknown as SmsSendResult;
    return behaviour;
  }
}
