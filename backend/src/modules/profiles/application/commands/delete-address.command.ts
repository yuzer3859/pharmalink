import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { ProfileErrors } from '../../domain/errors';
import { addressRemovedEvent, defaultAddressChangedEvent } from '../../domain/events';
import {
  ADDRESS_REPOSITORY,
  IAddressRepository,
} from '../../domain/repositories/address.repository';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { runWithDefaultAddressRetry } from '../support/default-address-conflict';

export interface DeleteAddressInput {
  userId: string;
  addressId: string;
}

/**
 * DELETE /addresses/:id (module-02 §8.2). Soft-delete only. If the default address is removed
 * and other addresses remain, the most-recently-updated remaining address is promoted to
 * default in the same transaction — a user is never left with zero default while addresses
 * still exist (edge case 10).
 */
@Injectable()
export class DeleteAddressCommand {
  constructor(
    @Inject(ADDRESS_REPOSITORY) private readonly addresses: IAddressRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: DeleteAddressInput): Promise<void> {
    // DEFECT-PROFILES-002 / ADR-010: the soft-delete, optional promotion, audit entry and
    // outbox event(s) all commit atomically in this one transaction — a failure anywhere in the
    // closure rolls back all of them, never leaving an orphan audit row, a missed event, or a
    // user with zero default while addresses still exist. The transaction runs at Serializable
    // isolation (keeps the audit hash chain fork-safe); `runWithDefaultAddressRetry` retries on
    // the resulting write-conflict, or on the default-address partial unique index (§6.3) if the
    // promotion races a concurrent default change, rather than surfacing a 500.
    await runWithDefaultAddressRetry(this.uow, async (tx) => {
      const found = await this.addresses.findById(input.addressId, tx);
      if (!found || found.userId !== input.userId || found.deletedAt) {
        throw ProfileErrors.notFound();
      }

      const wasDefault = found.isDefault;
      found.softDelete();
      await this.addresses.save(found, tx);

      let promotedId: string | null = null;
      if (wasDefault) {
        const replacement = await this.addresses.findMostRecentlyUpdatedForUser(
          input.userId,
          found.id,
          tx,
        );
        if (replacement) {
          replacement.markDefault();
          await this.addresses.save(replacement, tx);
          promotedId = replacement.id;
        }
      }

      await this.audit.record(
        {
          actorUserId: input.userId,
          action: 'ADDRESS_REMOVED',
          resourceType: 'Address',
          resourceId: found.id,
          context: { wasDefault },
        },
        tx,
      );

      await this.outbox.write(
        addressRemovedEvent({ userId: input.userId, addressId: found.id, wasDefault }),
        tx as never,
      );

      if (promotedId) {
        await this.outbox.write(
          defaultAddressChangedEvent({
            userId: input.userId,
            addressId: promotedId,
            previousAddressId: found.id,
          }),
          tx as never,
        );
      }
    });
  }
}
