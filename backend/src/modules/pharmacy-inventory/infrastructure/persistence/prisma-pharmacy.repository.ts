import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { Pharmacy, PharmacyProps } from '../../domain/entities/pharmacy.entity';
import { LicenseStatus, TransactingStatus } from '../../domain/enums';
import { IPharmacyRepository } from '../../domain/repositories/pharmacy.repository';

type Client = PrismaService | Prisma.TransactionClient;

@Injectable()
export class PrismaPharmacyRepository implements IPharmacyRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  private toProps(row: {
    id: string;
    organizationId: string;
    displayName: string;
    logoUrl: string | null;
    description: string | null;
    ratingAvg: number;
    ratingCount: number;
    transactingStatus: TransactingStatus;
    licenseStatus: LicenseStatus;
    licenseExpiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }): PharmacyProps {
    return { ...row };
  }

  async findById(id: string, tx?: unknown): Promise<Pharmacy | null> {
    const row = await this.client(tx).pharmacy.findUnique({ where: { id } });
    return row ? Pharmacy.rehydrate(this.toProps(row)) : null;
  }

  async findByOrganizationId(organizationId: string, tx?: unknown): Promise<Pharmacy | null> {
    const row = await this.client(tx).pharmacy.findUnique({ where: { organizationId } });
    return row ? Pharmacy.rehydrate(this.toProps(row)) : null;
  }

  async create(pharmacy: Pharmacy, tx?: unknown): Promise<void> {
    const p = pharmacy.toProps();
    await this.client(tx).pharmacy.create({
      data: {
        id: p.id,
        organizationId: p.organizationId,
        displayName: p.displayName,
        logoUrl: p.logoUrl,
        description: p.description,
        ratingAvg: p.ratingAvg,
        ratingCount: p.ratingCount,
        transactingStatus: p.transactingStatus,
        licenseStatus: p.licenseStatus,
        licenseExpiresAt: p.licenseExpiresAt,
      },
    });
  }

  async update(pharmacy: Pharmacy, tx?: unknown): Promise<void> {
    const p = pharmacy.toProps();
    await this.client(tx).pharmacy.update({
      where: { id: p.id },
      data: {
        displayName: p.displayName,
        logoUrl: p.logoUrl,
        description: p.description,
        transactingStatus: p.transactingStatus,
        licenseStatus: p.licenseStatus,
        licenseExpiresAt: p.licenseExpiresAt,
      },
    });
  }

  async findExpiredActive(now: Date, limit: number, tx?: unknown): Promise<Pharmacy[]> {
    const rows = await this.client(tx).pharmacy.findMany({
      where: {
        transactingStatus: TransactingStatus.ACTIVE,
        licenseExpiresAt: { lte: now },
      },
      take: limit,
    });
    return rows.map((r) => Pharmacy.rehydrate(this.toProps(r)));
  }
}
