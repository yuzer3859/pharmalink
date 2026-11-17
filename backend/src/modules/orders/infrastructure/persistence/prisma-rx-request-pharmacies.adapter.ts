import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { RxRequestPolicy } from '../../domain/services/rx-request-policy';
import {
  EligibleRxPharmacy,
  IRxRequestPharmaciesPort,
  PharmacistPharmacy,
  RxPrescriptionSummary,
} from '../../application/ports/outbound/rx-request-pharmacies.port';

const PHARMACIST_ROLE_KEY = 'PHARMACIST';

/** Work 134: see `IRxRequestPharmaciesPort`. */
@Injectable()
export class PrismaRxRequestPharmaciesAdapter implements IRxRequestPharmaciesPort {
  constructor(private readonly prisma: PrismaService) {}

  async findEligible(point: { lat: number; lng: number }, radiusMeters: number, now: Date): Promise<EligibleRxPharmacy[]> {
    const pharmacies = await this.prisma.pharmacy.findMany({
      where: {
        deletedAt: null,
        transactingStatus: 'ACTIVE',
        licenseStatus: 'VALID',
        OR: [{ licenseExpiresAt: null }, { licenseExpiresAt: { gt: now } }],
      },
      select: {
        id: true,
        organizationId: true,
        branches: { where: { isActive: true, deletedAt: null, lat: { not: null }, lng: { not: null } }, select: { id: true, lat: true, lng: true } },
      },
    });
    if (pharmacies.length === 0) return [];

    const organizationIds = pharmacies.map((p) => p.organizationId);
    const [activeOrgs, pharmacistRoles] = await Promise.all([
      this.prisma.organization.findMany({ where: { id: { in: organizationIds }, status: 'ACTIVE', deletedAt: null }, select: { id: true } }),
      this.prisma.userRole.findMany({
        where: { organizationId: { in: organizationIds }, role: { key: PHARMACIST_ROLE_KEY }, user: { status: 'ACTIVE' } },
        select: { organizationId: true },
      }),
    ]);
    const active = new Set(activeOrgs.map((o) => o.id));
    const withPharmacist = new Set(pharmacistRoles.map((r) => r.organizationId));

    const eligible: EligibleRxPharmacy[] = [];
    for (const pharmacy of pharmacies) {
      if (!active.has(pharmacy.organizationId) || !withPharmacist.has(pharmacy.organizationId)) continue;
      let nearest: { branchId: string; distanceMeters: number } | null = null;
      for (const branch of pharmacy.branches) {
        const distanceMeters = RxRequestPolicy.distanceMeters(point, { lat: branch.lat as number, lng: branch.lng as number });
        if (distanceMeters <= radiusMeters && (!nearest || distanceMeters < nearest.distanceMeters)) {
          nearest = { branchId: branch.id, distanceMeters };
        }
      }
      if (nearest) eligible.push({ pharmacyId: pharmacy.id, ...nearest });
    }
    return eligible.sort((a, b) => a.distanceMeters - b.distanceMeters);
  }

  async staffUserIds(pharmacyIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (pharmacyIds.length === 0) return result;
    const pharmacies = await this.prisma.pharmacy.findMany({ where: { id: { in: pharmacyIds } }, select: { id: true, organizationId: true } });
    const organizationIds = pharmacies.map((p) => p.organizationId);
    const [orgs, roles] = await Promise.all([
      this.prisma.organization.findMany({ where: { id: { in: organizationIds } }, select: { id: true, ownerUserId: true } }),
      this.prisma.userRole.findMany({
        where: { organizationId: { in: organizationIds }, role: { key: PHARMACIST_ROLE_KEY } },
        select: { organizationId: true, userId: true },
      }),
    ]);
    for (const pharmacy of pharmacies) {
      const owner = orgs.find((o) => o.id === pharmacy.organizationId)?.ownerUserId;
      const pharmacists = roles.filter((r) => r.organizationId === pharmacy.organizationId).map((r) => r.userId);
      result.set(pharmacy.id, [...new Set([...(owner ? [owner] : []), ...pharmacists])]);
    }
    return result;
  }

  async pharmaciesWherePharmacist(userId: string): Promise<PharmacistPharmacy[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId, organizationId: { not: null }, role: { key: PHARMACIST_ROLE_KEY } },
      select: { organizationId: true },
    });
    return this.pharmaciesOf(roles.map((r) => r.organizationId as string));
  }

  async pharmaciesOfStaff(userId: string): Promise<PharmacistPharmacy[]> {
    const [roles, owned] = await Promise.all([
      this.prisma.userRole.findMany({ where: { userId, organizationId: { not: null } }, select: { organizationId: true } }),
      this.prisma.organization.findMany({ where: { ownerUserId: userId }, select: { id: true } }),
    ]);
    return this.pharmaciesOf([...roles.map((r) => r.organizationId as string), ...owned.map((o) => o.id)]);
  }

  async displayNames(pharmacyIds: string[]): Promise<Map<string, string>> {
    if (pharmacyIds.length === 0) return new Map();
    const rows = await this.prisma.pharmacy.findMany({ where: { id: { in: pharmacyIds } }, select: { id: true, displayName: true } });
    return new Map(rows.map((r) => [r.id, r.displayName]));
  }

  async customerNames(userIds: string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.customerProfile.findMany({ where: { userId: { in: unique }, deletedAt: null }, select: { userId: true, fullName: true } });
    return new Map(rows.map((r) => [r.userId, r.fullName?.trim() || null]));
  }

  async prescriptionSummaries(prescriptionIds: string[]): Promise<Map<string, RxPrescriptionSummary>> {
    if (prescriptionIds.length === 0) return new Map();
    const rows = await this.prisma.prescription.findMany({
      where: { id: { in: prescriptionIds } },
      select: { id: true, fileType: true, doctorName: true, hospitalName: true, createdAt: true },
    });
    return new Map(rows.map((r) => [r.id, { id: r.id, fileType: r.fileType, doctorName: r.doctorName, hospitalName: r.hospitalName, uploadedAt: r.createdAt }]));
  }

  async sellableAt(branchId: string, productIds: string[]): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.prisma.inventoryListing.findMany({
      where: { branchId, catalogProductId: { in: productIds }, isEnabled: true, deletedAt: null },
      select: { catalogProductId: true, sellable: true },
    });
    const result = new Map<string, number>();
    for (const r of rows) result.set(r.catalogProductId, (result.get(r.catalogProductId) ?? 0) + r.sellable);
    return result;
  }

  private async pharmaciesOf(organizationIds: string[]): Promise<PharmacistPharmacy[]> {
    const unique = [...new Set(organizationIds)];
    if (unique.length === 0) return [];
    const rows = await this.prisma.pharmacy.findMany({ where: { organizationId: { in: unique }, deletedAt: null }, select: { id: true, organizationId: true } });
    return rows.map((r) => ({ pharmacyId: r.id, organizationId: r.organizationId }));
  }
}
