import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { CustomerProfile as PrismaCustomerProfile, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { CustomerProfile } from '../../domain/entities/customer-profile.entity';
import { Gender } from '../../domain/enums';
import { IProfileRepository } from '../../domain/repositories/profile.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toDomain(row: PrismaCustomerProfile): CustomerProfile {
  return CustomerProfile.rehydrate({
    id: row.id,
    userId: row.userId,
    fullName: row.fullName,
    gender: row.gender as unknown as Gender | null,
    dateOfBirth: row.dateOfBirth,
    secondaryPhone: row.secondaryPhone,
    timezone: row.timezone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });
}

@Injectable()
export class PrismaProfileRepository implements IProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUserId(userId: string): Promise<CustomerProfile | null> {
    const row = await this.prisma.customerProfile.findUnique({ where: { userId } });
    return row ? toDomain(row) : null;
  }

  async findOrCreateByUserId(userId: string, tx?: unknown): Promise<CustomerProfile> {
    const client = (tx as Client) ?? this.prisma;
    // Upsert with an empty `update` is a no-op on an existing row, so concurrent callers
    // (event handler + GET safety net, §2) can never duplicate or clobber a profile.
    const row = await client.customerProfile.upsert({
      where: { userId },
      create: { id: randomUUID(), userId, fullName: null },
      update: {},
    });
    return toDomain(row);
  }

  async save(profile: CustomerProfile, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = profile.toProps();
    await client.customerProfile.update({
      where: { id: props.id },
      data: {
        fullName: props.fullName,
        gender: props.gender as unknown as PrismaCustomerProfile['gender'],
        dateOfBirth: props.dateOfBirth,
        secondaryPhone: props.secondaryPhone,
        timezone: props.timezone,
      },
    });
  }
}
