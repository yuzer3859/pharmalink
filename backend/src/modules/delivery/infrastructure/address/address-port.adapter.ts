import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeliveryAddressView,
  IAddressPort,
} from '../../application/ports/outbound/address.port';

/**
 * Module 08's own `IAddressPort` adapter — a direct, in-process `PrismaService.address.findFirst`
 * read of Module 02's `Address` model (ADR-002), never a Prisma relation. Own copy, mirroring the
 * one Module 06 keeps.
 *
 * **Ownership is in the `where` clause, not in a check after it.** `userId: customerUserId` means
 * there is no code path — present or future, however this adapter is later edited — that returns
 * an address belonging to somebody else, and a mismatched id reads exactly like a missing one. The
 * caller turns the `null` into `NOT_FOUND`, so a delivery quote cannot be used to probe which
 * address ids exist or whose they are.
 *
 * Soft-deleted addresses are excluded for the same reason, and `line1` maps from Module 02's
 * `addressLine` column exactly as Module 06's copy does — the two adapters project the same four
 * fields because they answer the same question, not because either imports the other.
 */
@Injectable()
export class AddressPortAdapter implements IAddressPort {
  constructor(private readonly prisma: PrismaService) {}

  async getAddress(
    addressId: string,
    customerUserId: string,
  ): Promise<DeliveryAddressView | null> {
    const address = await this.prisma.address.findFirst({
      where: { id: addressId, userId: customerUserId, deletedAt: null },
      select: { lat: true, lng: true, addressLine: true, city: true },
    });
    if (!address) {
      return null;
    }
    return {
      lat: address.lat,
      lng: address.lng,
      line1: address.addressLine,
      city: address.city,
    };
  }
}
