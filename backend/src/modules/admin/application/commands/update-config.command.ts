import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { ConfigValueType } from '../../domain/enums';
import { AdminErrors } from '../../domain/errors';
import { configChangedEvent } from '../../domain/events';
import {
  PlatformConfig,
  PlatformConfigProps,
} from '../../domain/entities/platform-config.entity';
import {
  IPlatformConfigRepository,
  PLATFORM_CONFIG_REPOSITORY,
} from '../../domain/repositories/platform-config.repository';
import { ConfigKey } from '../../domain/value-objects/config-key.vo';
import { ConfigValue } from '../../domain/value-objects/config-value.vo';
import { ConfigOverrideLoader } from '../../infrastructure/config/config-override.loader';

export interface UpdateConfigInput {
  /** From the verified access token. There is no DTO field through which an actor could arrive. */
  actorUserId: string;
  namespace: string;
  key: string;
  valueType: ConfigValueType;
  value: unknown;
  reason?: string | null;
}

export interface UpdateConfigResult {
  config: PlatformConfigProps;
  /** The version this one replaced, or `null` when the key had never been configured. */
  previous: PlatformConfigProps | null;
}

/**
 * `UpdateConfig` — publishes a new version of a governed setting (module-16 §6, §11.3).
 *
 * ## The order of operations, and why each step is where it is
 *
 * 1. **Resolve the key.** `ConfigKey.of` refuses anything outside `ConfigCatalogue`, so a request
 *    naming a secret or an unknown key stops here with `NOT_FOUND` — before validation, before a
 *    transaction, and before anything is written.
 * 2. **Validate the value** against the owning module's own declared contract. Nothing is written
 *    if this fails: §4's "invalid config rejected before publication" is achieved by ordering, not
 *    by a rollback.
 * 3. **Read the current version** to compute the next one and to capture the "before" the audit
 *    entry needs.
 * 4. **One transaction**: deactivate the old active row, insert the new active row, write the audit
 *    entry, write the `ConfigChanged` event to the outbox. All four commit together or none does —
 *    a published value whose event was lost would leave other instances serving the old value until
 *    their next refresh with nothing to say why, and an audit entry for a change that rolled back
 *    would be a record of something that never happened.
 * 5. **Refresh this instance's snapshot** *after* the commit, so the administrator's very next read
 *    reflects what they just published. Other instances converge on their own timer.
 *
 * ## Concurrency
 *
 * Two administrators publishing the same key race on two database guarantees rather than on
 * application logic: `(namespace, key, version)` is unique, so they cannot both write version *n*,
 * and `platform_configs_one_active_per_key` is a partial unique index, so they cannot both end up
 * active. The loser gets `null` from `insert` and is told to re-read — deliberately *not* retried
 * automatically, because their value was chosen against a version they can no longer see, and
 * re-applying it blindly would overwrite a decision they never knew was taken.
 */
@Injectable()
export class UpdateConfigCommand {
  constructor(
    @Inject(PLATFORM_CONFIG_REPOSITORY)
    private readonly configs: IPlatformConfigRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly loader: ConfigOverrideLoader,
  ) {}

  async execute(input: UpdateConfigInput): Promise<UpdateConfigResult> {
    const actorUserId = (input.actorUserId ?? '').trim();
    if (!actorUserId) {
      throw AdminErrors.validation('actorUserId is required.', { field: 'actorUserId' });
    }

    // Step 1 and 2 — both refuse before anything is written.
    const key = ConfigKey.of(input.namespace, input.key);
    const value = ConfigValue.of(key, input.valueType, input.value);

    const previous = await this.configs.findActive(key.namespace, key.key);
    const maxVersion = await this.configs.maxVersion(key.namespace, key.key);

    const next = PlatformConfig.publish({
      id: randomUUID(),
      key,
      value,
      previousVersion: maxVersion,
      reason: input.reason ?? null,
      updatedBy: actorUserId,
    }).toProps();

    const written = await this.publish(next, previous, actorUserId);
    if (!written) {
      throw AdminErrors.concurrentConfigChange(key.namespace, key.key);
    }

    // After the commit, never inside it: a snapshot refreshed from an uncommitted transaction would
    // publish a value that a rollback could still take away.
    await this.loader.refresh();

    return { config: written, previous };
  }

  /**
   * The atomic publish. Returns `null` when the version race was lost.
   *
   * `ReadCommitted` — the default — is sufficient here and `Serializable` would not add anything:
   * the two invariants that matter are enforced by unique indexes, which hold at any isolation
   * level, and there is no read-compute-write over a range that could suffer a phantom.
   */
  private async publish(
    next: PlatformConfigProps,
    previous: PlatformConfigProps | null,
    actorUserId: string,
  ): Promise<PlatformConfigProps | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.configs.deactivateActive(next.namespace, next.key, tx);

        const written = await this.configs.insert(next, tx);
        if (!written) {
          // Lost the race. Thrown rather than returned so the transaction unwinds — a unique
          // violation has already aborted it, and the re-read must happen on a fresh connection.
          throw new VersionRaceLost();
        }

        await this.audit.record(
          {
            actorUserId,
            action: 'CONFIG_CHANGED',
            resourceType: 'PlatformConfig',
            resourceId: `${next.namespace}.${next.key}`,
            context: {
              namespace: next.namespace,
              key: next.key,
              valueType: next.valueType,
              // Before and after, which §13 of the brief asks for and which is safe here for one
              // specific reason: `ConfigCatalogue` contains no secret, so every value that can
              // reach this line is a business tunable — a fee, a TTL, a boolean. A generic config
              // store could not make this claim and would have to redact.
              previousVersion: previous?.version ?? null,
              previousValue: previous?.value ?? null,
              newVersion: next.version,
              newValue: next.value,
              reason: next.reason,
            },
          },
          tx,
        );

        await this.outbox.write(
          configChangedEvent({
            namespace: next.namespace,
            key: next.key,
            version: next.version,
            changedBy: actorUserId,
          }),
          tx as OutboxCapableClient,
        );

        return written;
      });
    } catch (err) {
      if (err instanceof VersionRaceLost) {
        return null;
      }
      // A partial unique violation on the active index means another transaction activated a
      // version for this key between our deactivate and our insert. Same lost race, different
      // index.
      if (isUniqueViolation(err)) {
        return null;
      }
      throw err;
    }
  }
}

/** Internal signal that unwinds the publish transaction on a lost version race. */
class VersionRaceLost extends Error {}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}
