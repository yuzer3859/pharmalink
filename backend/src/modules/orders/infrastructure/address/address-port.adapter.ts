import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { AddressView, IAddressPort } from '../../application/ports/outbound/address.port';

/**
 * Module 06's own `IAddressPort` adapter (`06-orders-spec.md` §5) — a direct, in-process
 * `PrismaService.address.findFirst` read of Module 02's `Address` model, never a Prisma relation
 * (ADR-002). Module 02 exports nothing, so Module 06 builds its own adapter, exactly as Modules
 * 04/05 already do for their `ICatalogPort` copies.
 *
 * Ownership is enforced **in the query itself** (`userId: customerUserId`), per the port contract:
 * this never returns another customer's address, so a mismatched `addressId` is indistinguishable
 * from a genuine miss (no existence leakage across customers, `00-shared-conventions.md` §1 — the
 * same discipline `GetPrescriptionQuery`/`GetOrderQuery` already apply). Soft-deleted addresses are
 * excluded for the same reason. The caller (`CheckoutCommand`) turns a `null` into its existing
 * `notFound('Address not found.')`.
 *
 * `line1` maps from Module 02's `addressLine` column — the `AddressSnapshot` shape (§3.10) names
 * the field `line1`, the `Address` model stores it as `addressLine`; only the four fields checkout
 * actually consumes are projected, never the whole row (which carries `recipientPhone` and other
 * PII the order snapshot has no need for).
 */
@Injectable()
export class AddressPortAdapter implements IAddressPort {
  constructor(private readonly prisma: PrismaService) {}

  async getAddress(addressId: string, customerUserId: string): Promise<AddressView | null> {
    const address = await this.prisma.address.findFirst({
      where: { id: addressId, userId: customerUserId, deletedAt: null },
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
