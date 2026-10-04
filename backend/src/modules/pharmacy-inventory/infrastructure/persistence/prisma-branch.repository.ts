import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { Branch, BranchProps } from '../../domain/entities/branch.entity';
import { BranchOperatingHourProps } from '../../domain/entities/branch-operating-hour.entity';
import { IBranchRepository } from '../../domain/repositories/branch.repository';

type Client = PrismaService | Prisma.TransactionClient;

@Injectable()
export class PrismaBranchRepository implements IBranchRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<Branch | null> {
    const row = await this.client(tx).branch.findUnique({ where: { id } });
    return row ? Branch.rehydrate(row as BranchProps) : null;
  }

  async findManyByPharmacy(pharmacyId: string, tx?: unknown): Promise<Branch[]> {
    const rows = await this.client(tx).branch.findMany({
      where: { pharmacyId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => Branch.rehydrate(r as BranchProps));
  }

  async create(branch: Branch, tx?: unknown): Promise<void> {
    const b = branch.toProps();
    await this.client(tx).branch.create({
      data: {
        id: b.id,
        pharmacyId: b.pharmacyId,
        name: b.name,
        region: b.region,
        city: b.city,
        subcity: b.subcity,
        woreda: b.woreda,
        addressLine: b.addressLine,
        lat: b.lat,
        lng: b.lng,
        phone: b.phone,
        isActive: b.isActive,
      },
    });
  }

  async update(branch: Branch, tx?: unknown): Promise<void> {
    const b = branch.toProps();
    await this.client(tx).branch.update({
      where: { id: b.id },
      data: {
        name: b.name,
        region: b.region,
        city: b.city,
        subcity: b.subcity,
        woreda: b.woreda,
        addressLine: b.addressLine,
        lat: b.lat,
        lng: b.lng,
        phone: b.phone,
        isActive: b.isActive,
      },
    });
  }

  async replaceOperatingHours(
    branchId: string,
    hours: Array<Omit<BranchOperatingHourProps, 'id' | 'branchId'>>,
    tx?: unknown,
  ): Promise<void> {
    const client = this.client(tx);
    await client.branchOperatingHour.deleteMany({ where: { branchId } });
    if (hours.length > 0) {
      await client.branchOperatingHour.createMany({
        data: hours.map((h) => ({ id: randomUUID(), branchId, ...h })),
      });
    }
  }

  async listOperatingHours(branchId: string, tx?: unknown): Promise<BranchOperatingHourProps[]> {
    const rows = await this.client(tx).branchOperatingHour.findMany({
      where: { branchId },
      orderBy: { weekday: 'asc' },
    });
    return rows as BranchOperatingHourProps[];
  }
}
