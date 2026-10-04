import { Injectable } from '@nestjs/common';
import { Address as PrismaAddress, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { Address } from '../../domain/entities/address.entity';
import { AddressLabel } from '../../domain/enums';
import { IAddressRepository } from '../../domain/repositories/address.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toDomain(row: PrismaAddress): Address {
  return Address.rehydrate({
    id: row.id,
    userId: row.userId,
    label: row.label as unknown as AddressLabel,
    recipientName: row.recipientName,
    recipientPhone: row.recipientPhone,
    region: row.region,
    city: row.city,
    subcity: row.subcity,
    woreda: row.woreda,
    landmark: row.landmark,
    addressLine: row.addressLine,
    lat: row.lat ?? 0,
    lng: row.lng ?? 0,
    isDefault: row.isDefault,
    isWithinEthiopia: row.isWithinEthiopia,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });
}

@Injectable()
export class PrismaAddressRepository implements IAddressRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: unknown): Promise<Address | null> {
    const client = (tx as Client) ?? this.prisma;
    const row = await client.address.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async listByUserId(userId: string): Promise<Address[]> {
    const rows = await this.prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    return rows.map(toDomain);
  }

  async countByUserId(userId: string, tx?: unknown): Promise<number> {
    const client = (tx as Client) ?? this.prisma;
    return client.address.count({ where: { userId, deletedAt: null } });
  }

  async create(address: Address, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = address.toProps();
    await client.address.create({
      data: {
        id: props.id,
        userId: props.userId,
        beneficiaryId: null,
        label: props.label as unknown as PrismaAddress['label'],
        recipientName: props.recipientName,
        recipientPhone: props.recipientPhone,
        region: props.region,
        city: props.city,
        subcity: props.subcity,
        woreda: props.woreda,
        landmark: props.landmark,
        addressLine: props.addressLine,
        lat: props.lat,
        lng: props.lng,
        isDefault: props.isDefault,
        isWithinEthiopia: props.isWithinEthiopia,
      },
    });
  }

  async save(address: Address, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = address.toProps();
    await client.address.update({
      where: { id: props.id },
      data: {
        label: props.label as unknown as PrismaAddress['label'],
        recipientName: props.recipientName,
        recipientPhone: props.recipientPhone,
        region: props.region,
        city: props.city,
        subcity: props.subcity,
        woreda: props.woreda,
        landmark: props.landmark,
        addressLine: props.addressLine,
        lat: props.lat,
        lng: props.lng,
        isDefault: props.isDefault,
        isWithinEthiopia: props.isWithinEthiopia,
        deletedAt: props.deletedAt,
      },
    });
  }

  async clearDefaultForUser(userId: string, tx?: unknown): Promise<string | null> {
    const client = (tx as Client) ?? this.prisma;
    const current = await client.address.findFirst({
      where: { userId, isDefault: true, deletedAt: null },
      select: { id: true },
    });
    if (!current) {
      return null;
    }
    await client.address.update({
      where: { id: current.id },
      data: { isDefault: false },
    });
    return current.id;
  }

  async findMostRecentlyUpdatedForUser(
    userId: string,
    excludeId: string,
    tx?: unknown,
  ): Promise<Address | null> {
    const client = (tx as Client) ?? this.prisma;
    const row = await client.address.findFirst({
      where: { userId, deletedAt: null, id: { not: excludeId } },
      orderBy: { updatedAt: 'desc' },
    });
    return row ? toDomain(row) : null;
  }
}
