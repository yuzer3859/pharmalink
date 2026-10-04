import { ConfigValueType } from '../enums';
import { AdminErrors } from '../errors';
import { ConfigKey } from '../value-objects/config-key.vo';
import { ConfigPrimitive, ConfigValue } from '../value-objects/config-value.vo';

/** The longest change reason an operator may record. */
export const MAX_CONFIG_REASON_LENGTH = 500;

/** One stored version of one setting. */
export interface PlatformConfigProps {
  id: string;
  namespace: string;
  key: string;
  value: ConfigPrimitive;
  valueType: ConfigValueType;
  version: number;
  isActive: boolean;
  reason: string | null;
  /** `users.id` of the publishing administrator. */
  updatedBy: string;
  createdAt: Date;
}

export interface NewPlatformConfigInput {
  id: string;
  key: ConfigKey;
  value: ConfigValue;
  /** The version this one follows. `0` means the key has never been configured. */
  previousVersion: number;
  reason?: string | null;
  updatedBy: string;
  now?: Date;
}

/**
 * `PlatformConfig` — one immutable version of one governed setting (module-16 §5.1).
 *
 * ## The aggregate is the *version*, not the key
 *
 * This is the decision everything else follows from. An aggregate per key would have a mutable
 * `value`, and every update would overwrite the answer to "what was in force when this order was
 * priced?" — the question a configuration audit exists to answer. An aggregate per *version* means
 * a change is an insert, history is what the table already contains, and there is no update path to
 * get wrong.
 *
 * There is consequently **no setter on this class and no `update` on its repository**. The only
 * mutation anywhere in the module is the compare-and-set that moves `isActive` from one row to
 * another, and even that never touches a value, a type, a version or an actor.
 *
 * ## Publishing is two rows changing together
 *
 * Activating version *n* and deactivating version *n−1* must commit together, or the platform
 * briefly has either two active values or none. The command wraps both in one transaction, and the
 * partial unique index `platform_configs_one_active_per_key` is the backstop that makes "two
 * active" unrepresentable rather than merely unlikely.
 */
export class PlatformConfig {
  private constructor(private readonly props: PlatformConfigProps) {}

  /**
   * Builds the next version of a setting.
   *
   * Always `previousVersion + 1`, never a caller-supplied number: a version is a position in a
   * sequence, and letting a request name it would let two administrators publish version 4 with
   * different values and no way to tell which came first. The unique index on
   * `(namespace, key, version)` enforces the same thing at the storage layer.
   *
   * Created **active**. A version that existed but was in force at no point would be a decision
   * nobody made, and the only way to produce one would be a publish that half-failed — which the
   * transaction prevents.
   */
  static publish(input: NewPlatformConfigInput): PlatformConfig {
    const reason = normalizeReason(input.reason);
    if (reason !== null && reason.length > MAX_CONFIG_REASON_LENGTH) {
      throw AdminErrors.validation(
        `reason must be at most ${MAX_CONFIG_REASON_LENGTH} characters.`,
        { field: 'reason' },
      );
    }
    const updatedBy = (input.updatedBy ?? '').trim();
    if (!updatedBy) {
      // Not reachable through HTTP — the controller takes the actor from the verified token — but
      // asserted here so an in-process caller cannot publish an unattributed change either.
      throw AdminErrors.validation('updatedBy is required.', { field: 'updatedBy' });
    }
    if (!Number.isInteger(input.previousVersion) || input.previousVersion < 0) {
      throw AdminErrors.validation('previousVersion must be a non-negative integer.', {
        field: 'previousVersion',
      });
    }

    return new PlatformConfig({
      id: input.id,
      namespace: input.key.namespace,
      key: input.key.key,
      value: input.value.value,
      valueType: input.value.type,
      version: input.previousVersion + 1,
      isActive: true,
      reason,
      updatedBy,
      createdAt: input.now ?? new Date(),
    });
  }

  static rehydrate(props: PlatformConfigProps): PlatformConfig {
    return new PlatformConfig({ ...props });
  }

  toProps(): PlatformConfigProps {
    return { ...this.props };
  }

  get id(): string {
    return this.props.id;
  }

  get version(): number {
    return this.props.version;
  }

  /** The dotted path feature modules read. */
  get path(): string {
    return `${this.props.namespace}.${this.props.key}`;
  }
}

function normalizeReason(reason?: string | null): string | null {
  const text = (reason ?? '').trim();
  return text.length === 0 ? null : text;
}
