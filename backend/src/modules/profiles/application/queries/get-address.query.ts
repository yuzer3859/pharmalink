import { Inject, Injectable } from '@nestjs/common';
import { ProfileErrors } from '../../domain/errors';
import {
  ADDRESS_REPOSITORY,
  IAddressRepository,
} from '../../domain/repositories/address.repository';
import { AddressView, toAddressView } from './address-view';

/**
 * GET /addresses/:id (module-02 §8.2). Ownership mismatch and "does not exist" both return
 * `404 NOT_FOUND` — never `403` — so a non-owner cannot learn the resource exists (§7.3/§12).
 */
@Injectable()
export class GetAddressQuery {
  constructor(
    @Inject(ADDRESS_REPOSITORY) private readonly addresses: IAddressRepository,
  ) {}

  async execute(userId: string, addressId: string): Promise<AddressView> {
    const address = await this.addresses.findById(addressId);
    if (!address || address.userId !== userId || address.deletedAt) {
      throw ProfileErrors.notFound();
    }
    return toAddressView(address);
  }
}
