import { AdminErrors } from '../errors';
import { ConfigCatalogue, ConfigKeyDefinition } from '../services/config-catalogue';

/** The longest a namespace or key segment may be. Generous; the catalogue's longest is 33. */
export const MAX_CONFIG_SEGMENT_LENGTH = 64;

/**
 * A segment must read like an identifier: the dotted path it forms is what feature modules pass to
 * `IConfigPort.get()`, and a segment containing a dot would silently address a different key than
 * the one an operator typed.
 */
const SEGMENT = /^[a-zA-Z][a-zA-Z0-9]*$/;

/**
 * `ConfigKey` — a validated `namespace.key` path (module-16 §5.2).
 *
 * ## Why this is a value object rather than two strings
 *
 * The path is the join between three things that must agree: the route parameters an administrator
 * supplies, the `(namespace, key)` columns a version is stored under, and the dotted string a
 * feature module reads. Constructing it in one place means the three cannot drift — and it means
 * the **catalogue check happens on construction**, so there is no code path that builds a key
 * outside the governable set and then forgets to check it.
 *
 * A key that is not in `ConfigCatalogue` cannot be constructed at all. That is the property §18
 * rests on: no `ConfigKey` for `TELEBIRR_API_SECRET` can exist, so no command can write one and no
 * resolver can read one.
 */
export class ConfigKey {
  private constructor(
    readonly namespace: string,
    readonly key: string,
    readonly definition: ConfigKeyDefinition,
  ) {}

  /**
   * Parses and validates a namespace/key pair.
   *
   * Refuses, in order: a malformed segment, then a path the catalogue does not carry. The order
   * matters for the message an operator sees — "that is not a valid key name" and "that key is not
   * governable" are different problems with different fixes.
   */
  static of(namespace: string, key: string): ConfigKey {
    const ns = (namespace ?? '').trim();
    const k = (key ?? '').trim();

    for (const [label, value] of [
      ['namespace', ns],
      ['key', k],
    ] as const) {
      if (!value) {
        throw AdminErrors.validation(`${label} is required.`, { field: label });
      }
      if (value.length > MAX_CONFIG_SEGMENT_LENGTH) {
        throw AdminErrors.validation(
          `${label} must be at most ${MAX_CONFIG_SEGMENT_LENGTH} characters.`,
          { field: label },
        );
      }
      if (!SEGMENT.test(value)) {
        throw AdminErrors.validation(
          `${label} must be alphanumeric and start with a letter.`,
          { field: label, value },
        );
      }
    }

    const definition = ConfigCatalogue.find(ns, k);
    if (!definition) {
      // Deliberately does not say whether some *other* key in the namespace exists, and never
      // echoes a value. An operator probing for governable keys learns only what the catalogue
      // already tells them through `GET /admin/config`.
      throw AdminErrors.configKeyNotGovernable(ns, k);
    }

    return new ConfigKey(ns, k, definition);
  }

  /** The dotted path feature modules read — `orders.platformFeePercent`. */
  get path(): string {
    return `${this.namespace}.${this.key}`;
  }

  toString(): string {
    return this.path;
  }
}
