/** The Resend e-mail events this module acts on (module-13 Work 18). */
export const RESEND_EMAIL_EVENTS = ['email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained'] as const;
export type ResendEmailEventType = (typeof RESEND_EMAIL_EVENTS)[number];

/**
 * The only parts of a Resend webhook this module reads. Everything else in the payload — `from`,
 * `subject`, `message_id`, `tags`, the bounce message — is never read, kept or logged.
 */
export interface ResendEmailEvent {
  type: ResendEmailEventType;
  /** The event's own `created_at`, or `null` if absent / unparseable. */
  occurredAt: Date | null;
  /** `data.email_id` — the id Resend returned when the e-mail was sent. */
  emailId: string;
  /** `data.to` — the impacted recipients, raw; used only to compute suppression keys. */
  to: string[];
  /** `data.bounce.type` for `email.bounced` (Resend: `Permanent`, `Transient`, `Undetermined`). */
  bounceType: string | null;
}

/**
 * Parses an already signature-verified body. Returns `null` for anything that is not one of the
 * four e-mail events with an `email_id` — those are acknowledged and ignored, never acted on.
 */
export function parseResendEmailEvent(rawBody: Buffer): ResendEmailEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  const event = json as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> };
  if (typeof event?.type !== 'string' || !(RESEND_EMAIL_EVENTS as readonly string[]).includes(event.type)) return null;
  const data = event.data;
  const emailId = data?.email_id;
  if (typeof emailId !== 'string' || emailId.length === 0 || emailId.length > 128) return null;
  const to = Array.isArray(data?.to) ? data.to.filter((t): t is string => typeof t === 'string') : typeof data?.to === 'string' ? [data.to] : [];
  const created = typeof event.created_at === 'string' ? new Date(event.created_at) : null;
  const bounce = data?.bounce as { type?: unknown } | undefined;
  return {
    type: event.type as ResendEmailEventType,
    occurredAt: created && !Number.isNaN(created.getTime()) ? created : null,
    emailId,
    to,
    bounceType: typeof bounce?.type === 'string' ? bounce.type : null,
  };
}

/** The event type, for the receipt, when the body is otherwise unusable. Never more than 64 chars. */
export function eventTypeOf(rawBody: Buffer): string {
  try {
    const t = (JSON.parse(rawBody.toString('utf8')) as { type?: unknown })?.type;
    return typeof t === 'string' && /^[a-z0-9._-]{1,64}$/i.test(t) ? t : 'unknown';
  } catch {
    return 'unknown';
  }
}
