import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { AddressLabel } from '../../domain/enums';
import { ProfileErrors } from '../../domain/errors';
import { addressUpdatedEvent, defaultAddressChangedEvent } from '../../domain/events';
import {
  ADDRESS_REPOSITORY,
  IAddressRepository,
} from '../../domain/repositories/address.repository';
import { PhoneNumber } from '../../domain/value-objects/phone-number';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { AddressView, toAddressView } from '../queries/address-view';
import { runWithDefaultAddressRetry } from '../support/default-address-conflict';

export interface UpdateAddressInput {
  userId: string;
  addressId: string;
  label?: string;
  recipientName?: string;
  recipientPhone?: string;
  region?: string;
  city?: string;
  subcity?: string;
  woreda?: string;
  landmark?: string;
  addressLine?: string;
  lat?: number;
  lng?: number;
  isDefault?: boolean;
}

/** PATCH /addresses/:id (module-02 §8.2). All fields optional, at least one required. */
@Injectable()
export class UpdateAddressCommand {
  constructor(
    @Inject(ADDRESS_REPOSITORY) private readonly addresses: IAddressRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: UpdateAddressInput): Promise<AddressView> {
    const hasAnyField =
      input.label !== undefined ||
      input.recipientName !== undefined ||
      input.recipientPhone !== undefined ||
      input.region !== undefined ||
      input.city !== undefined ||
      input.subcity !== undefined ||
      input.woreda !== undefined ||
      input.landmark !== undefined ||
      input.addressLine !== undefined ||
      input.lat !== undefined ||
      input.lng !== undefined ||
      input.isDefault !== undefined;
    if (!hasAnyField) {
      throw ProfileErrors.validation('At least one field is required.');
    }

    const recipientPhone =
      input.recipientPhone !== undefined
        ? PhoneNumber.create(input.recipientPhone, 'recipientPhone').value
        : undefined;

    // DEFECT-PROFILES-002 / ADR-010: the state change, audit entry and outbox event all commit
    // atomically in this one transaction — a failure anywhere in the closure rolls back all
    // three, never leaving a partially-applied edit, an orphan audit row, or a missed event.
    //
    // A PATCH that promotes this address to default (isDefault: true) performs the same
    // clear-old-default + set-new-default swap as SetDefaultAddressCommand and so races the same
    // way; retry the closure against re-read state when the partial unique index (§6.3) — or,
    // since the whole transaction now runs at Serializable isolation to keep the audit hash
    // chain fork-safe, a concurrent audit-append write-conflict — rejects a losing commit, rather
    // than returning a 500 (DEFECT-PROFILES-001, edge case 8).
    const address = await runWithDefaultAddressRetry(this.uow, async (tx) => {
      const found = await this.addresses.findById(input.addressId, tx);
      if (!found || found.userId !== input.userId || found.deletedAt) {
        throw ProfileErrors.notFound();
      }

      const changedFields = found.applyEdits({
        label: input.label as AddressLabel | undefined,
        recipientName: input.recipientName,
        recipientPhone,
        region: input.region,
        city: input.city,
        subcity: input.subcity,
        woreda: input.woreda,
        landmark: input.landmark,
        addressLine: input.addressLine,
        lat: input.lat,
        lng: input.lng,
      });

      let previousDefault: string | null = null;
      if (input.isDefault === true && !found.isDefault) {
        previousDefault = await this.addresses.clearDefaultForUser(input.userId, tx);
        found.markDefault();
        changedFields.push('isDefault');
      } else if (input.isDefault === false) {
        found.clearDefault(); // throws DEFAULT_ADDRESS_REQUIRED if currently default
      }

      await this.addresses.save(found, tx);

      await this.audit.record(
        {
          actorUserId: input.userId,
          action: 'ADDRESS_UPDATED',
          resourceType: 'Address',
          resourceId: found.id,
          context: { fields: changedFields },
        },
        tx,
      );

      if (changedFields.includes('isDefault')) {
        await this.outbox.write(
          defaultAddressChangedEvent({
            userId: input.userId,
            addressId: found.id,
            previousAddressId: previousDefault,
          }),
          tx as never,
        );
      } else {
        await this.outbox.write(
          addressUpdatedEvent({ userId: input.userId, addressId: found.id, fields: changedFields }),
          tx as never,
        );
      }

      return found;
    });

    return toAddressView(address);
  }
}
