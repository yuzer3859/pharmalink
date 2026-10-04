import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { FeatureFlag, FeatureFlagProps } from '../../domain/entities/feature-flag.entity';
import { AdminErrors } from '../../domain/errors';
import { featureFlagToggledEvent } from '../../domain/events';
import {
  FEATURE_FLAG_REPOSITORY,
  IFeatureFlagRepository,
} from '../../domain/repositories/feature-flag.repository';
import { ConfigOverrideLoader } from '../../infrastructure/config/config-override.loader';

export interface ToggleFeatureFlagInput {
  /** From the verified access token. */
  actorUserId: string;
  key: string;
  enabled: boolean;
  description?: string | null;
}

export interface ToggleFeatureFlagResult {
  flag: FeatureFlagProps;
  /** `true` when this call created the flag rather than moving an existing one. */
  created: boolean;
  /** `false` when the flag was already in the requested state — an idempotent repeat. */
  changed: boolean;
}

/**
 * `ToggleFeatureFlag` — turns a capability on or off (module-16 §6, F-AD-13).
 *
 * ## Three outcomes, and each one is a different truth
 *
 * - **Created.** No row existed. One is inserted in the requested state, and the audit entry
 *   records a previous state of `null` — not `DISABLED`, because "nobody had decided" and
 *   "somebody decided off" are different facts and the environment fallback means they behaved
 *   differently too.
 * - **Changed.** A row existed in the other state and was moved by compare-and-set.
 * - **Unchanged.** A row existed already in the requested state. Nothing is written — no row, no
 *   audit entry, no event. Re-enabling an enabled flag is not a governance event, and recording one
 *   would fill the audit trail with decisions nobody took.
 *
 * ## Concurrency
 *
 * Two administrators toggling at once resolve through two database guarantees. Creating races on
 * `feature_flags.key @unique`: the loser's insert returns `null`, and it re-reads on a fresh
 * connection and continues as a toggle. Moving races on the compare-and-set in `updateStatus`,
 * which matches only while the row still holds the state that was read — so a stale "disable"
 * cannot overwrite an "enable" that landed first; it simply finds nothing to move and reports the
 * winner's state.
 */
@Injectable()
export class ToggleFeatureFlagCommand {
  constructor(
    @Inject(FEATURE_FLAG_REPOSITORY) private readonly flags: IFeatureFlagRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly loader: ConfigOverrideLoader,
  ) {}

  async execute(input: ToggleFeatureFlagInput): Promise<ToggleFeatureFlagResult> {
    const actorUserId = (input.actorUserId ?? '').trim();
    if (!actorUserId) {
      throw AdminErrors.validation('actorUserId is required.', { field: 'actorUserId' });
    }
    const key = FeatureFlag.normalizeKey(input.key);

    const existing = await this.flags.findByKey(key);
    const result = existing
      ? await this.move(existing, input, actorUserId)
      : await this.create(key, input, actorUserId);

    if (result.changed) {
      await this.loader.refresh();
    }
    return result;
  }

  /** First time this flag has ever been administered. */
  private async create(
    key: string,
    input: ToggleFeatureFlagInput,
    actorUserId: string,
  ): Promise<ToggleFeatureFlagResult> {
    const flag = FeatureFlag.create({
      id: randomUUID(),
      key,
      enabled: input.enabled,
      description: input.description ?? null,
      updatedByUserId: actorUserId,
    }).toProps();

    const written = await this.prisma.$transaction(async (tx) => {
      const inserted = await this.flags.insert(flag, tx);
      if (!inserted) {
        return null;
      }
      await this.writeTrail(tx, actorUserId, key, null, input.enabled);
      return inserted;
    });

    if (written) {
      return { flag: written, created: true, changed: true };
    }

    // Somebody created it first. Re-read outside the aborted transaction and continue as a move —
    // the caller asked for a state, not for the privilege of being the one to create the row.
    const winner = await this.flags.findByKey(key);
    if (!winner) {
      // The insert failed for a reason that was not a key collision after all.
      throw AdminErrors.featureFlagInvalid('Feature flag could not be created.', { key });
    }
    return this.move(winner, input, actorUserId);
  }

  /** A row already exists — move it if it is not already where the caller wants it. */
  private async move(
    existing: FeatureFlagProps,
    input: ToggleFeatureFlagInput,
    actorUserId: string,
  ): Promise<ToggleFeatureFlagResult> {
    const current = FeatureFlag.rehydrate(existing);
    const wantedDescription =
      input.description === undefined ? existing.description : (input.description ?? null);

    if (current.isEnabled === input.enabled && wantedDescription === existing.description) {
      // Already there. Nothing written — see the class comment.
      return { flag: existing, created: false, changed: false };
    }

    const next = current
      .toggle({
        enabled: input.enabled,
        description: input.description,
        updatedByUserId: actorUserId,
      })
      .toProps();

    const written = await this.prisma.$transaction(async (tx) => {
      const moved = await this.flags.updateStatus(
        existing.key,
        existing.status,
        {
          status: next.status,
          description: next.description,
          updatedByUserId: actorUserId,
          updatedAt: next.updatedAt,
        },
        tx,
      );
      if (!moved) {
        return null;
      }
      await this.writeTrail(tx, actorUserId, existing.key, current.isEnabled, input.enabled);
      return moved;
    });

    if (written) {
      return { flag: written, created: false, changed: true };
    }

    // Lost the compare-and-set. Report where the flag actually ended up rather than pretending
    // this call decided it.
    const now = await this.flags.findByKey(existing.key);
    return { flag: now ?? existing, created: false, changed: false };
  }

  /**
   * The audit entry and the event, inside the caller's transaction.
   *
   * A flag's whole content is its key and a boolean, and both are carried — unlike a config value.
   * There is nothing to redact: a flag name is not a secret and its state is already observable in
   * the behaviour of the feature it gates.
   */
  private async writeTrail(
    tx: unknown,
    actorUserId: string,
    key: string,
    previousEnabled: boolean | null,
    enabled: boolean,
  ): Promise<void> {
    await this.audit.record(
      {
        actorUserId,
        action: 'FEATURE_FLAG_TOGGLED',
        resourceType: 'FeatureFlag',
        resourceId: key,
        context: {
          key,
          // `null` means the flag had never been administered and the environment was deciding.
          previousEnabled,
          enabled,
        },
      },
      tx,
    );

    await this.outbox.write(
      featureFlagToggledEvent({ key, enabled, changedBy: actorUserId }),
      tx as OutboxCapableClient,
    );
  }
}
