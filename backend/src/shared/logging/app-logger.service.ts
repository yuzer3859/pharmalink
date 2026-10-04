import { ConsoleLogger, Injectable, LogLevel, Scope } from '@nestjs/common';

/**
 * Keys whose values must never appear in logs (defense-in-depth against PII/secret leakage).
 * Matching is case-insensitive and substring-based.
 */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'secret',
  'token',
  'authorization',
  'otp',
  'pin',
  'card',
  'cvv',
  'ssn',
  'fayda',
  'encryptionkey',
  'masterkey',
];

const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Recursively redact sensitive keys from an arbitrary structure. Exported for unit testing.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value as object)) {
    return '[Circular]';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, seen);
  }
  return out;
}

/**
 * Application logger. Wraps Nest's ConsoleLogger, redacts sensitive fields, and emits
 * structured JSON in production for log aggregation. Transient scope so each context gets
 * its own instance/context label.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class AppLogger extends ConsoleLogger {
  private json = process.env.NODE_ENV === 'production';
  private ctx?: string;

  setJsonOutput(enabled: boolean): void {
    this.json = enabled;
  }

  setContext(context: string): void {
    this.ctx = context;
    super.setContext(context);
  }

  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    this.write('error', message, context ?? stackOrContext, stackOrContext);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  private write(level: LogLevel, message: unknown, context?: string, stack?: string): void {
    const safeMessage = redact(message);
    if (this.json) {
      const entry = {
        level,
        time: new Date().toISOString(),
        context: context ?? this.ctx,
        message: safeMessage,
        ...(stack && level === 'error' ? { stack } : {}),
      };
      // eslint-disable-next-line no-console
      process.stdout.write(JSON.stringify(entry) + '\n');
      return;
    }

    const rendered =
      typeof safeMessage === 'string' ? safeMessage : JSON.stringify(safeMessage);
    switch (level) {
      case 'error':
        super.error(rendered, stack, context);
        break;
      case 'warn':
        super.warn(rendered, context);
        break;
      case 'debug':
        super.debug(rendered, context);
        break;
      case 'verbose':
        super.verbose(rendered, context);
        break;
      default:
        super.log(rendered, context);
    }
  }
}
