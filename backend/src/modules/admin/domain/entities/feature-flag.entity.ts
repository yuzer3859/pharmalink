import { FeatureFlagStatus } from '../enums';
import { AdminErrors } from '../errors';

/** Flag keys read like identifiers, and are compared case-insensitively after normalization. */
const FLAG_KEY = /^[a-z][a-z0-9_]*$/;

export const MAX_FEATURE_FLAG_KEY_LENGTH = 100;
export const MAX_FEATURE_FLAG_DESCRIPTION_LENGTH = 500;

export interface FeatureFlagProps {
  id: string;
  key: string;
  description: string | null;
  status: FeatureFlagStatus;
  /** `users.id` of the administrator who last changed it, or `null` for a seeded row. */
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `FeatureFlag` — a named capability switch (module-16 §5.1, §6).
 *
 * ## On/off, and only on/off, in this work
 *
 * The Phase-0 table already carries `rolloutPercent` and `targetRules`, and the `FeatureFlagStatus`
 * enum already has a `PARTIAL` member. **None of the three is written here.** §9 of the brief is
 * explicit that percentage rollout is not part of this work, and a flag stored as `PARTIAL` with a
 * rollout percentage that nothing evaluates would be worse than absent: every reader would have to
 * decide for itself what "partially enabled" means, and they would not all decide the same thing.
 *
 * So `toggle` writes `ENABLED` or `DISABLED`, `isEnabled` reads exactly those, and a `PARTIAL` row
 * — which only a later work or a manual edit could create — is reported as **not** enabled. That is
 * the conservative reading: a capability whose rollout rules cannot be evaluated is a capability
 * nobody has established should be on for this caller.
 *
 * ## Missing is not disabled
 *
 * A flag with no row does not reach this class at all. The resolver falls back to the environment's
 * `FEATURE_<KEY>` check, which is what the platform already did before this module existed — see
 * `PlatformConfigResolver.isFeatureEnabled`. §10's "safe when missing" is honoured by *not* having
 * an opinion here.
 */
export class FeatureFlag {
  private constructor(private readonly props: FeatureFlagProps) {}

  static create(input: {
    id: string;
    key: string;
    enabled: boolean;
    description?: string | null;
    updatedByUserId: string;
    now?: Date;
  }): FeatureFlag {
    const now = input.now ?? new Date();
    return new FeatureFlag({
      id: input.id,
      key: FeatureFlag.normalizeKey(input.key),
      description: normalizeDescription(input.description),
      status: input.enabled ? FeatureFlagStatus.ENABLED : FeatureFlagStatus.DISABLED,
      updatedByUserId: requireActor(input.updatedByUserId),
      createdAt: now,
      updatedAt: now,
    });
  }

  static rehydrate(props: FeatureFlagProps): FeatureFlag {
    return new FeatureFlag({ ...props });
  }

  /**
   * Normalizes and validates a flag key.
   *
   * Lower-cased, because `FEATURE_COD` and `feature_cod` naming the same capability through two
   * spellings is how a flag ends up enabled in one code path and disabled in another. The uppercase
   * environment form is derived from this on read, not stored.
   */
  static normalizeKey(raw: string): string {
    const key = (raw ?? '').trim().toLowerCase();
    if (!key) {
      throw AdminErrors.featureFlagInvalid('key is required.', { field: 'key' });
    }
    if (key.length > MAX_FEATURE_FLAG_KEY_LENGTH) {
      throw AdminErrors.featureFlagInvalid(
        `key must be at most ${MAX_FEATURE_FLAG_KEY_LENGTH} characters.`,
        { field: 'key' },
      );
    }
    if (!FLAG_KEY.test(key)) {
      throw AdminErrors.featureFlagInvalid(
        'key must be lowercase alphanumeric with underscores, starting with a letter.',
        { field: 'key', value: key },
      );
    }
    return key;
  }

  /** `ENABLED` only. `PARTIAL` reads as off — see the class comment. */
  get isEnabled(): boolean {
    return this.props.status === FeatureFlagStatus.ENABLED;
  }

  get key(): string {
    return this.props.key;
  }

  toProps(): FeatureFlagProps {
    return { ...this.props };
  }

  /**
   * Returns this flag switched to `enabled`, leaving the receiver untouched.
   *
   * A new instance rather than a mutation, so a caller that needs the previous state for the audit
   * entry still holds it — which is exactly what `ToggleFeatureFlagCommand` does.
   */
  toggle(input: {
    enabled: boolean;
    description?: string | null;
    updatedByUserId: string;
    now?: Date;
  }): FeatureFlag {
    return new FeatureFlag({
      ...this.props,
      status: input.enabled ? FeatureFlagStatus.ENABLED : FeatureFlagStatus.DISABLED,
      description:
        input.description === undefined
          ? this.props.description
          : normalizeDescription(input.description),
      updatedByUserId: requireActor(input.updatedByUserId),
      updatedAt: input.now ?? new Date(),
    });
  }
}

function normalizeDescription(description?: string | null): string | null {
  const text = (description ?? '').trim();
  if (text.length === 0) {
    return null;
  }
  if (text.length > MAX_FEATURE_FLAG_DESCRIPTION_LENGTH) {
    throw AdminErrors.featureFlagInvalid(
      `description must be at most ${MAX_FEATURE_FLAG_DESCRIPTION_LENGTH} characters.`,
      { field: 'description' },
    );
  }
  return text;
}

function requireActor(updatedByUserId: string): string {
  const actor = (updatedByUserId ?? '').trim();
  if (!actor) {
    throw AdminErrors.featureFlagInvalid('updatedByUserId is required.', {
      field: 'updatedByUserId',
    });
  }
  return actor;
}
