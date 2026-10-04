import { Inject, Injectable } from '@nestjs/common';
import { AdminErrors } from '../../domain/errors';
import {
  IPlatformConfigRepository,
  PLATFORM_CONFIG_REPOSITORY,
} from '../../domain/repositories/platform-config.repository';
import { UpdateConfigCommand, UpdateConfigResult } from './update-config.command';

export interface RollbackConfigInput {
  /** From the verified access token. */
  actorUserId: string;
  namespace: string;
  key: string;
  /** The historical version whose value should come back into force. */
  toVersion: number;
  reason?: string | null;
}

/**
 * `RollbackConfig` — brings an earlier version's value back into force (module-16 §6's "revert to
 * prior version").
 *
 * ## Rollback is a forward step
 *
 * `v1 → v2 → v3`, rolled back to `v1`, produces **`v4` carrying `v1`'s value** — not `v1` becoming
 * active again. §8 of the work brief requires exactly this, and the reason is that the alternative
 * destroys the property the whole model exists for: if activating an old row were possible, then
 * `isActive` would no longer describe a sequence of decisions, and "what was in force on Tuesday?"
 * would have no answer, because a version could have been in force more than once with no record
 * of when.
 *
 * Writing a new version instead means the history reads as what actually happened: somebody decided
 * on Tuesday to go back to what the platform did on Monday, and that decision has its own row, its
 * own actor, its own timestamp and its own audit entry.
 *
 * ## It re-validates
 *
 * The old value goes through `UpdateConfigCommand` in full, including `ConfigValue.of`. That is
 * deliberate: a bound may have tightened since the old version was published — a maximum lowered,
 * an allowed set narrowed — and a value that the owning module would refuse today must not come
 * back into force just because it was once acceptable. A rollback that cannot be validated fails
 * with `CONFIG_VALIDATION_FAILED`, which tells the operator exactly what stands in the way.
 *
 * Everything else — the transaction, the audit entry, the `ConfigChanged` event, the snapshot
 * refresh — is `UpdateConfigCommand`'s, unchanged. A rollback that took its own path through those
 * would be a second publish implementation to keep in step with the first.
 */
@Injectable()
export class RollbackConfigCommand {
  constructor(
    @Inject(PLATFORM_CONFIG_REPOSITORY)
    private readonly configs: IPlatformConfigRepository,
    private readonly update: UpdateConfigCommand,
  ) {}

  async execute(input: RollbackConfigInput): Promise<UpdateConfigResult> {
    const namespace = (input.namespace ?? '').trim();
    const key = (input.key ?? '').trim();

    if (!Number.isInteger(input.toVersion) || input.toVersion < 1) {
      throw AdminErrors.validation('toVersion must be a positive integer.', {
        field: 'toVersion',
      });
    }

    const target = await this.configs.findVersion(namespace, key, input.toVersion);
    if (!target) {
      throw AdminErrors.configVersionNotFound(namespace, key, input.toVersion);
    }
    if (target.isActive) {
      // Rolling back to what is already in force would write a version identical to its
      // predecessor — a decision with no effect, and a history entry that tells a later reader
      // nothing. Refused rather than silently accepted.
      throw AdminErrors.validation('That version is already active.', {
        namespace,
        key,
        version: input.toVersion,
      });
    }

    return this.update.execute({
      actorUserId: input.actorUserId,
      namespace,
      key,
      valueType: target.valueType,
      value: target.value,
      reason:
        input.reason?.trim() ||
        // A default that says what happened, because a rollback with no stated reason is still a
        // rollback and the history should say so.
        `Rolled back to version ${target.version}.`,
    });
  }
}
