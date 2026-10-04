import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  BranchPickupView,
  IPharmacyPort,
} from '../../application/ports/outbound/pharmacy.port';

/**
 * Module 08's own `IPharmacyPort` adapter — a direct, in-process `PrismaService.branch` read of
 * Module 04's `branches` (ADR-002), never a Prisma relation. Own copy, mirroring Modules 06 and
 * 07.
 *
 * Soft-deleted branches are treated as absent, consistently with every other adapter in the
 * codebase. The consequence is deliberate and mild: a job cut against a deleted branch gets no
 * pickup coordinates rather than failing, because the fulfillment is real and the order still has
 * to reach the customer — an operator can correct a missing pickup point, but a job that was never
 * created is one nobody knows to look for.
 */
@Injectable()
export class PharmacyPortAdapter implements IPharmacyPort {
  constructor(private readonly prisma: PrismaService) {}

  async getBranchPickup(branchId: string): Promise<BranchPickupView | null> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      select: {
        id: true,
        pharmacyId: true,
        lat: true,
        lng: true,
        name: true,
        addressLine: true,
        subcity: true,
        city: true,
      },
    });
    if (!branch) {
      return null;
    }
    return {
      branchId: branch.id,
      pharmacyId: branch.pharmacyId,
      lat: branch.lat,
      lng: branch.lng,
      addressLine: composeAddressLine(branch),
    };
  }
}

/**
 * One legible line for a driver, assembled from the parts Module 04 stores separately. The branch
 * name leads because that is what a driver looks for on a shopfront; the geographic parts follow
 * from most to least specific.
 */
function composeAddressLine(branch: {
  name: string;
  addressLine: string | null;
  subcity: string | null;
  city: string | null;
}): string | null {
  const parts = [branch.name, branch.addressLine, branch.subcity, branch.city].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  return parts.length > 0 ? parts.map((part) => part.trim()).join(', ') : null;
}
