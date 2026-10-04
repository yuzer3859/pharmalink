import { Injectable } from '@nestjs/common';
import { Prisma, User as PrismaUser } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { User } from '../../domain/entities/user.entity';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import {
  IUserRepository,
  NewUserData,
  PaginatedUsers,
  UserSearchFilter,
} from '../../domain/repositories/user.repository';

type Client = PrismaService | Prisma.TransactionClient;

/** Maps a Prisma `User` row to the framework-free domain aggregate. */
function toDomain(row: PrismaUser): User {
  return User.rehydrate({
    id: row.id,
    phone: row.phone,
    email: row.email,
    passwordHash: row.passwordHash,
    primaryRole: row.primaryRole as unknown as PrimaryRole,
    status: row.status as unknown as AccountStatus,
    preferredLanguage: row.preferredLanguage as unknown as PreferredLanguage,
    phoneVerifiedAt: row.phoneVerifiedAt,
    emailVerifiedAt: row.emailVerifiedAt,
    faydaVerifiedAt: row.faydaVerifiedAt,
    guardianId: row.guardianId,
    permVersion: row.permVersion,
    deletionRequestedAt: row.deletionRequestedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });
}

@Injectable()
export class PrismaUserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findByPhone(phone: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { phone } });
    return row ? toDomain(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
    return row ? toDomain(row) : null;
  }

  async findByIdentifier(identifier: string): Promise<User | null> {
    return identifier.includes('@') ? this.findByEmail(identifier) : this.findByPhone(identifier);
  }

  async search(filter: UserSearchFilter, page: number, size: number): Promise<PaginatedUsers> {
    const where: Prisma.UserWhereInput = {
      ...(filter.status && { status: filter.status as unknown as PrismaUser['status'] }),
      ...(filter.primaryRole && {
        primaryRole: filter.primaryRole as unknown as PrismaUser['primaryRole'],
      }),
      ...(filter.identifier && {
        [filter.identifier.includes('@') ? 'email' : 'phone']: filter.identifier,
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        // Newest first: an administrator's list is most often "who just signed up". `id` breaks
        // same-millisecond ties so a page boundary is stable.
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items: rows.map(toDomain), total, page, size };
  }

  async create(data: NewUserData, tx?: unknown): Promise<User> {
    const client = (tx as Client) ?? this.prisma;
    const row = await client.user.create({
      data: {
        phone: data.phone,
        email: data.email,
        passwordHash: data.passwordHash,
        primaryRole: data.primaryRole as unknown as PrismaUser['primaryRole'],
        status: data.status as unknown as PrismaUser['status'],
        preferredLanguage: data.preferredLanguage as unknown as PrismaUser['preferredLanguage'],
      },
    });
    return toDomain(row);
  }

  async save(user: User, tx?: unknown): Promise<void> {
    const client = (tx as Client) ?? this.prisma;
    const props = user.toProps();
    await client.user.update({
      where: { id: props.id },
      data: {
        phone: props.phone,
        email: props.email,
        passwordHash: props.passwordHash,
        status: props.status as unknown as PrismaUser['status'],
        preferredLanguage: props.preferredLanguage as unknown as PrismaUser['preferredLanguage'],
        phoneVerifiedAt: props.phoneVerifiedAt,
        emailVerifiedAt: props.emailVerifiedAt,
        faydaVerifiedAt: props.faydaVerifiedAt,
        permVersion: props.permVersion,
        deletionRequestedAt: props.deletionRequestedAt,
      },
    });
  }
}
