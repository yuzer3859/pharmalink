import { Injectable } from '@nestjs/common';
import { Manufacturer as PrismaManufacturer, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { Manufacturer } from '../../domain/entities/manufacturer.entity';
import { IManufacturerRepository } from '../../domain/repositories/manufacturer.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toDomain(row: PrismaManufacturer): Manufacturer {
  return Manufacturer.rehydrate({
    id: row.id,
    name: row.name,
    country: row.country,
    status: row.status,
    createdAt: row.createdAt,
  });
}

@Injectable()
export class PrismaManufacturerRepository implements IManufacturerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: unknown): Promise<Manufacturer | null> {
    const client = (tx as Client) ?? this.prisma;
    const row = await client.manufacturer.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findByName(name: string): Promise<Manufacturer | null> {
    const row = await this.prisma.manufacturer.findUnique({ where: { name } });
    return row ? toDomain(row) : null;
  }

  async create(manufacturer: Manufacturer, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = manufacturer.toProps();
    await client.manufacturer.create({
      data: {
        id: props.id,
        name: props.name,
        country: props.country,
        status: props.status,
        createdAt: props.createdAt,
      },
    });
  }

  async save(manufacturer: Manufacturer, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = manufacturer.toProps();
    await client.manufacturer.update({
      where: { id: props.id },
      data: { name: props.name, country: props.country, status: props.status },
    });
  }

  async list(): Promise<Manufacturer[]> {
    const rows = await this.prisma.manufacturer.findMany({ orderBy: { name: 'asc' } });
    return rows.map(toDomain);
  }
}
