import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { ProfileErrors } from '../../domain/errors';
import { defaultAddressChangedEvent } from '../../domain/events';
import {
  ADDRESS_REPOSITORY,
  IAddressRepository,
} from '../../domain/repositories/address.repository';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { AddressView, toAddressView } from '../queries/address-view';
import { runWithDefaultAddressRetry } from '../support/default-address-conflict';

export interface SetDefaultAddressInput {
  userId: string;
  addressId: string;
}

/**
 * POST /addresses/:id/default (module-02 §8.2). Kept separate from PATCH for a single
 * unambiguous audit action name and to avoid overloading PATCH semantics. Atomically clears
 * the previous default and sets this one, guarded by the partial unique index (§6.3).
 */
@Injectable()
export class SetDefaultAddressCommand {
  constructor(
    @Inject(ADDRESS_REPOSITORY) private readonly addresses: IAddressRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: SetDefaultAddressInput): Promise<AddressView> {
    // DEFECT-PROFILES-002 / ADR-010: the state change, audit entry and outbox event all commit
    // atomically in this one transaction — none of them is written after `uow.run` resolves, so
    // a failure anywhere in the closure (e.g. the outbox insert) rolls back all three, never
    // leaving a partially-applied default swap, an orphan audit row, or a missed event.
    //
    // The clear-old-default + set-new-default pair also races against concurrent set-default
    // calls; the partial unique index (§6.3) — and, since the whole transaction now runs at
    // Serializable isolation to keep the audit hash chain fork-safe, a write-conflict from a
    // concurrent audit append — rejects a losing commit, which we retry against freshly re-read
    // state rather than surfacing a 500 (DEFECT-PROFILES-001, edge case 8).
    const address = await runWithDefaultAddressRetry(this.uow, async (tx) => {
      const found = await this.addresses.findById(input.addressId, tx);
      if (!found || found.userId !== input.userId || found.deletedAt) {
        throw ProfileErrors.notFound();
      }

      let previousAddressId = found.id;
      if (!found.isDefault) {
        previousAddressId = (await this.addresses.clearDefaultForUser(input.userId, tx)) ?? found.id;
        found.markDefault();
        await this.addresses.save(found, tx);
      }

      // Matches the pre-DEFECT-PROFILES-002 behavior exactly: an audit entry is written on every
      // call (including the already-default no-op), while the outbox event is only emitted when
      // the default actually changed.
      await this.audit.record(
        {
          actorUserId: input.userId,
          action: 'ADDRESS_DEFAULT_CHANGED',
          resourceType: 'Address',
          resourceId: found.id,
          context: { previousAddressId },
        },
        tx,
      );

      if (previousAddressId !== found.id) {
        await this.outbox.write(
          defaultAddressChangedEvent({
            userId: input.userId,
            addressId: found.id,
            previousAddressId,
          }),
          tx as never,
        );
      }

      return found;
    });

    return toAddressView(address);
  }
}
