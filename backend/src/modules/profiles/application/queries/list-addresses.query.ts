import { Inject, Injectable } from '@nestjs/common';
import {
  ADDRESS_REPOSITORY,
  IAddressRepository,
} from '../../domain/repositories/address.repository';
import { AddressView, toAddressView } from './address-view';

/** GET /addresses (module-02 §8.2). No pagination in this slice — capped at 20 (§3.2). */
@Injectable()
export class ListAddressesQuery {
  constructor(
    @Inject(ADDRESS_REPOSITORY) private readonly addresses: IAddressRepository,
  ) {}

  async execute(userId: string): Promise<AddressView[]> {
    const rows = await this.addresses.listByUserId(userId);
    return rows.map(toAddressView);
  }
}
