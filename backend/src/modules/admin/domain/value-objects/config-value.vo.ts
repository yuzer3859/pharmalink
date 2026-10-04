import { ConfigValueType } from '../enums';
import { AdminErrors } from '../errors';
import { ConfigKey } from './config-key.vo';

/** What a configuration value may be once validated. */
export type ConfigPrimitive = boolean | number | string | Record<string, unknown> | unknown[];

/** The largest a `STRING` value may be. Config values are labels and modes, never documents. */
export const MAX_CONFIG_STRING_LENGTH = 512;

/**
 * `ConfigValue` — a value proven to match its key's declared type and the owning module's bounds
 * (module-16 §5.2, §6).
 *
 * ## Typed, not stringly
 *
 * The brief's §3 asks for typed configuration rather than "everything is a string", and the reason
 * is concrete: `delivery.codRequireExactAmount` is a boolean that decides whether a driver can
 * hand over the wrong amount of a customer's money. Stored as the string `"false"`, every reader
 * has to remember that `Boolean("false")` is `true`. Storing the boolean means the mistake cannot
 * be made downstream, and the one place a string *is* converted — this class — is the one place a
 * test can aim at.
 *
 * ## Where the rules come from
 *
 * All of them come from `ConfigKey.definition`, which is the catalogue entry, which imports the
 * constants the owning module already enforces on its environment variable. **No bound is decided
 * here.** This class knows how to check "is this an integer", "is it within [min, max]", "is it one
 * of the allowed values" — it does not know, and must never know, what a delivery fee ought to be.
 */
export class ConfigValue {
  private constructor(
    readonly type: ConfigValueType,
    readonly value: ConfigPrimitive,
  ) {}

  /**
   * Validates a supplied value against its key.
   *
   * The supplied `type` must match the catalogue's, rather than being trusted: an administrator who
   * sends `{"valueType":"STRING","value":"3"}` for an integer key is either confused or probing,
   * and silently coercing would store a string where every reader expects a number.
   */
  static of(key: ConfigKey, declaredType: ConfigValueType, raw: unknown): ConfigValue {
    const expected = key.definition.type;
    if (declaredType !== expected) {
      throw AdminErrors.configValidationFailed(
        `${key.path} is declared ${expected}, not ${declaredType}.`,
        { key: key.path, expected, received: declaredType },
      );
    }

    switch (expected) {
      case ConfigValueType.BOOLEAN:
        return new ConfigValue(expected, requireBoolean(key, raw));
      case ConfigValueType.INTEGER:
        return new ConfigValue(expected, requireInteger(key, raw));
      case ConfigValueType.DECIMAL:
        return new ConfigValue(expected, requireDecimal(key, raw));
      case ConfigValueType.STRING:
        return new ConfigValue(expected, requireString(key, raw));
      case ConfigValueType.JSON:
        return new ConfigValue(expected, requireJson(key, raw));
      default:
        // Unreachable while the enum and this switch agree; a new enum member lands here rather
        // than being stored unvalidated.
        throw AdminErrors.configValidationFailed(`Unsupported value type for ${key.path}.`, {
          key: key.path,
        });
    }
  }

  /**
   * Rebuilds a value already stored, skipping validation.
   *
   * Used only when reading a historical row back. A version that was valid when it was published
   * must still load even if the owning module's bounds have since narrowed — otherwise tightening a
   * bound would make the audit history unreadable, which is the opposite of what the history is
   * for. Rollback re-validates before republishing, so a value that is no longer acceptable cannot
   * come back into force silently.
   */
  static rehydrate(type: ConfigValueType, value: ConfigPrimitive): ConfigValue {
    return new ConfigValue(type, value);
  }
}

function requireBoolean(key: ConfigKey, raw: unknown): boolean {
  if (typeof raw === 'boolean') {
    return raw;
  }
  // `"true"`/`"false"` are accepted because an HTTP client that cannot express a JSON boolean is a
  // real thing; `1`/`0` are not, because a caller sending a number for a boolean key is more likely
  // to have sent the wrong field than to have meant it.
  if (raw === 'true' || raw === 'false') {
    return raw === 'true';
  }
  throw AdminErrors.configValidationFailed(`${key.path} must be a boolean.`, { key: key.path });
}

function requireInteger(key: ConfigKey, raw: unknown): number {
  const value = toNumber(key, raw);
  if (!Number.isInteger(value)) {
    throw AdminErrors.configValidationFailed(`${key.path} must be an integer.`, {
      key: key.path,
    });
  }
  return assertRange(key, value);
}

function requireDecimal(key: ConfigKey, raw: unknown): number {
  return assertRange(key, toNumber(key, raw));
}

function toNumber(key: ConfigKey, raw: unknown): number {
  const value =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) {
    throw AdminErrors.configValidationFailed(`${key.path} must be a finite number.`, {
      key: key.path,
    });
  }
  return value;
}

/** Applies the owning module's own bounds, where it declares any. */
function assertRange(key: ConfigKey, value: number): number {
  const { min, max } = key.definition;
  if (min !== undefined && value < min) {
    throw AdminErrors.configValidationFailed(`${key.path} must be at least ${min}.`, {
      key: key.path,
      min,
    });
  }
  if (max !== undefined && value > max) {
    throw AdminErrors.configValidationFailed(`${key.path} must be at most ${max}.`, {
      key: key.path,
      max,
    });
  }
  return value;
}

function requireString(key: ConfigKey, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw AdminErrors.configValidationFailed(`${key.path} must be a string.`, { key: key.path });
  }
  const value = raw.trim();
  if (!value) {
    throw AdminErrors.configValidationFailed(`${key.path} must not be blank.`, { key: key.path });
  }
  if (value.length > MAX_CONFIG_STRING_LENGTH) {
    throw AdminErrors.configValidationFailed(
      `${key.path} must be at most ${MAX_CONFIG_STRING_LENGTH} characters.`,
      { key: key.path },
    );
  }
  const { allowed } = key.definition;
  if (allowed && !allowed.includes(value)) {
    throw AdminErrors.configValidationFailed(
      `${key.path} must be one of: ${allowed.join(', ')}.`,
      { key: key.path, allowed: [...allowed] },
    );
  }
  return value;
}

function requireJson(key: ConfigKey, raw: unknown): Record<string, unknown> | unknown[] {
  if (raw === null || typeof raw !== 'object') {
    throw AdminErrors.configValidationFailed(`${key.path} must be an object or array.`, {
      key: key.path,
    });
  }
  return raw as Record<string, unknown> | unknown[];
}
