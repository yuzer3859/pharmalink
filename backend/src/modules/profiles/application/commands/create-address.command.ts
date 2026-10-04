import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Address, NewAddressProps } from '../../domain/entities/address.entity';
import { AddressLabel, MAX_ADDRESSES_PER_USER } from '../../domain/enums';
import { ProfileErrors } from '../../domain/errors';
import { addressAddedEvent } from '../../domain/events';
import {
  ADDRESS_REPOSITORY,
  IAddressRepository,
} from '../../domain/repositories/address.repository';
import { PhoneNumber } from '../../domain/value-objects/phone-number';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { AddressView, toAddressView } from '../queries/address-view';
import { runWithDefaultAddressRetry } from '../support/default-address-conflict';

export interface CreateAddressInput {
  userId: string;
  label?: string;
  recipientName: string;
  recipientPhone: string;
  region?: string;
  city?: string;
  subcity?: string;
  woreda?: string;
  landmark?: string;
  addressLine?: string;
  lat: number;
  lng: number;
  isDefault?: boolean;
}

/**
 * POST /addresses (module-02 §8.2). Order of checks matters for a predictable error contract:
 * DTO validation (upstream) -> locator rule + geofence (entity) -> max-20 -> default swap.
 */
@Injectable()
export class CreateAddressCommand {
  constructor(
    @Inject(ADDRESS_REPOSITORY) private readonly addresses: IAddressRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: CreateAddressInput): Promise<AddressView> {
    const recipientPhone = PhoneNumber.create(input.recipientPhone, 'recipientPhone').value;

    const newProps: NewAddressProps = {
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
    };

    // DEFECT-PROFILES-002 / ADR-010: the insert, audit entry and outbox event all commit
    // atomically in this one transaction — a failure anywhere in the closure rolls back all
    // three, never leaving an orphan address row, audit entry, or missed event.
    //
    // When this create also becomes the default (first address, or isDefault requested), the
    // clear-old-default + insert races concurrent default changes; the partial unique index
    // (§6.3) — and, since the whole transaction now runs at Serializable isolation to keep the
    // audit hash chain fork-safe, a write-conflict from a concurrent audit append — rejects a
    // losing commit, which we retry against re-read state instead of 500ing (DEFECT-PROFILES-001,
    // edge case 8). The count is re-read each attempt inside the tx.
    const address = await runWithDefaultAddressRetry(this.uow, async (tx) => {
      const existingCount = await this.addresses.countByUserId(input.userId, tx);
      if (existingCount >= MAX_ADDRESSES_PER_USER) {
        throw ProfileErrors.addressLimitReached();
      }

      const created = Address.create(randomUUID(), input.userId, newProps);
      const makeDefault = existingCount === 0 || input.isDefault === true;

      if (makeDefault) {
        await this.addresses.clearDefaultForUser(input.userId, tx);
        created.markDefault();
      }

      await this.addresses.create(created, tx);

      await this.audit.record(
        {
          actorUserId: input.userId,
          action: 'ADDRESS_ADDED',
          resourceType: 'Address',
          resourceId: created.id,
          context: { label: created.toProps().label, isDefault: created.isDefault },
        },
        tx,
      );

      await this.outbox.write(
        addressAddedEvent({
          userId: input.userId,
          addressId: created.id,
          label: created.toProps().label,
          isDefault: created.isDefault,
        }),
        tx as never,
      );

      return created;
    });

    return toAddressView(address);
  }
}
