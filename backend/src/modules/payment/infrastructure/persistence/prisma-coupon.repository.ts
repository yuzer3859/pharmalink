import { Injectable } from '@nestjs/common';
import {
  Coupon as PrismaCoupon,
  CouponRedemption as PrismaCouponRedemption,
  Prisma,
  RedemptionStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { CouponProps } from '../../domain/entities/coupon.entity';
import { CouponRedemptionProps } from '../../domain/entities/coupon-redemption.entity';
import {
  CouponPage,
  ICouponRepository,
  ListCouponsCriteria,
} from '../../domain/repositories/coupon.repository';
import { CouponScopeProps } from '../../domain/value-objects/coupon-scope.vo';

type Client = PrismaService | Prisma.TransactionClient;

function toCouponProps(row: PrismaCoupon): CouponProps {
  return {
    id: row.id,
    code: row.code,
    discountType: row.discountType,
    value: row.value,
    minSpend: row.minSpend,
    maxDiscount: row.maxDiscount,
    scope: (row.scope as CouponScopeProps | null) ?? null,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    usageLimitGlobal: row.usageLimitGlobal,
    usageLimitPerUser: row.usageLimitPerUser,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

function toRedemptionProps(row: PrismaCouponRedemption): CouponRedemptionProps {
  return {
    id: row.id,
    couponId: row.couponId,
    userId: row.userId,
    orderId: row.orderId,
    discountAmount: row.discountAmount,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * `ICouponRepository` over §7's `coupons` and `coupon_redemptions`. Plain domain snapshots cross
 * the boundary — no Prisma type escapes (ADR-002), same as every other repository here.
 *
 * **The two `count…` methods are the whole usage model.** F-CPN-02's global and per-user limits are
 * `COUNT(*) WHERE status = 'APPLIED'`, computed on demand; there is no counter column to increment
 * and none will be added. Excluding `REVERSED` rows from the count is also, by itself, the entire
 * mechanism by which F-CPN-03's reversal returns a usage to the pool.
 *
 * Every method accepts a `tx`, which is what lets `ApplyCouponCommand` put its count and its
 * insert in one `Serializable` transaction — the only way the global limit can hold under
 * concurrency (no row-level constraint can express "at most N rows in this group").
 */
@Injectable()
export class PrismaCouponRepository implements ICouponRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Client) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<CouponProps | null> {
    const row = await this.client(tx).coupon.findUnique({ where: { id } });
    return row ? toCouponProps(row) : null;
  }

  /** By the **canonical** code — the caller has already normalized through `CouponCode`. */
  async findByCode(code: string, tx?: unknown): Promise<CouponProps | null> {
    const row = await this.client(tx).coupon.findUnique({ where: { code } });
    return row ? toCouponProps(row) : null;
  }

  async list(criteria: ListCouponsCriteria, tx?: unknown): Promise<CouponPage> {
    const client = this.client(tx);
    const where: Prisma.CouponWhereInput = {
      ...(criteria.isActive === undefined ? {} : { isActive: criteria.isActive }),
      ...(criteria.codeContains ? { code: { contains: criteria.codeContains } } : {}),
    };

    const [rows, total] = await Promise.all([
      client.coupon.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      client.coupon.count({ where }),
    ]);

    return { items: rows.map(toCouponProps), total };
  }

  async create(coupon: CouponProps, tx?: unknown): Promise<CouponProps> {
    const row = await this.client(tx).coupon.create({
      data: {
        id: coupon.id,
        code: coupon.code,
        discountType: coupon.discountType,
        value: coupon.value,
        minSpend: coupon.minSpend,
        maxDiscount: coupon.maxDiscount,
        scope: (coupon.scope ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
        startsAt: coupon.startsAt,
        expiresAt: coupon.expiresAt,
        usageLimitGlobal: coupon.usageLimitGlobal,
        usageLimitPerUser: coupon.usageLimitPerUser,
        isActive: coupon.isActive,
      },
    });
    return toCouponProps(row);
  }

  async update(
    id: string,
    changes: Omit<CouponProps, 'id' | 'code' | 'createdAt'>,
    tx?: unknown,
  ): Promise<CouponProps> {
    const row = await this.client(tx).coupon.update({
      where: { id },
      data: {
        discountType: changes.discountType,
        value: changes.value,
        minSpend: changes.minSpend,
        maxDiscount: changes.maxDiscount,
        scope: (changes.scope ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
        startsAt: changes.startsAt,
        expiresAt: changes.expiresAt,
        usageLimitGlobal: changes.usageLimitGlobal,
        usageLimitPerUser: changes.usageLimitPerUser,
        isActive: changes.isActive,
        // `code` and `createdAt` are absent by type, not by discipline — a coupon's code is
        // printed and typed by customers, so it is immutable (see `Coupon`).
      },
    });
    return toCouponProps(row);
  }

  countAppliedForCoupon(couponId: string, tx?: unknown): Promise<number> {
    return this.client(tx).couponRedemption.count({
      where: { couponId, status: RedemptionStatus.APPLIED },
    });
  }

  countAppliedForCouponAndUser(
    couponId: string,
    userId: string,
    tx?: unknown,
  ): Promise<number> {
    return this.client(tx).couponRedemption.count({
      where: { couponId, userId, status: RedemptionStatus.APPLIED },
    });
  }

  async findRedemptionById(id: string, tx?: unknown): Promise<CouponRedemptionProps | null> {
    const row = await this.client(tx).couponRedemption.findUnique({ where: { id } });
    return row ? toRedemptionProps(row) : null;
  }

  async findRedemptionByCouponAndOrder(
    couponId: string,
    orderId: string,
    tx?: unknown,
  ): Promise<CouponRedemptionProps | null> {
    // §7's `@@unique([couponId, orderId])` — the idempotency identity of an application.
    const row = await this.client(tx).couponRedemption.findUnique({
      where: { couponId_orderId: { couponId, orderId } },
    });
    return row ? toRedemptionProps(row) : null;
  }

  async findRedemptionsByOrder(
    orderId: string,
    tx?: unknown,
  ): Promise<CouponRedemptionProps[]> {
    const rows = await this.client(tx).couponRedemption.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toRedemptionProps);
  }

  async findRedemptionsByCoupon(
    couponId: string,
    tx?: unknown,
  ): Promise<CouponRedemptionProps[]> {
    const rows = await this.client(tx).couponRedemption.findMany({
      where: { couponId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toRedemptionProps);
  }

  async createRedemption(
    redemption: CouponRedemptionProps,
    tx?: unknown,
  ): Promise<CouponRedemptionProps> {
    const row = await this.client(tx).couponRedemption.create({
      data: {
        id: redemption.id,
        couponId: redemption.couponId,
        userId: redemption.userId,
        orderId: redemption.orderId,
        discountAmount: redemption.discountAmount,
        status: redemption.status,
      },
    });
    return toRedemptionProps(row);
  }

  /**
   * The only mutation a redemption ever receives. Deliberately narrow: the coupon, user, order and
   * amount describe money that was already discounted and there is no method here that can change
   * them.
   */
  async updateRedemptionStatus(
    id: string,
    status: RedemptionStatus,
    tx?: unknown,
  ): Promise<CouponRedemptionProps> {
    const row = await this.client(tx).couponRedemption.update({
      where: { id },
      data: { status },
    });
    return toRedemptionProps(row);
  }
}
