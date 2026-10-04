import { Injectable } from '@nestjs/common';
import { Cart as PrismaCart, CartItem as PrismaCartItem, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  CartItemSnapshot,
  CartSnapshot,
  ICartRepository,
  NewCartItemData,
} from '../../domain/repositories/cart.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toCartItemSnapshot(row: PrismaCartItem): CartItemSnapshot {
  return {
    id: row.id,
    cartId: row.cartId,
    catalogProductId: row.catalogProductId,
    quantity: row.quantity,
    indicativePrice: row.indicativePrice,
    requiresRx: row.requiresRx,
    addedAt: row.addedAt,
  };
}

function toCartSnapshot(row: PrismaCart & { items: PrismaCartItem[] }): CartSnapshot {
  return {
    id: row.id,
    customerUserId: row.customerUserId,
    beneficiaryId: row.beneficiaryId,
    status: row.status,
    items: row.items.map(toCartItemSnapshot),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Prisma adapter for `ICartRepository` (module-06 `06-orders-spec.md` §3.1/§3.2, §14 step 4) —
 * persists the `Cart` aggregate root and its child `CartItem` rows via `carts` / `cart_items`
 * (`prisma/schema/06-orders.prisma`). Follows the same `tx?: unknown` pass-through convention as
 * `PrismaPrescriptionRepository`/`PrismaMatchRepository` (module-05): every mutating method uses
 * the caller-supplied `Prisma.TransactionClient` when given, otherwise falls back to the shared
 * `PrismaService` — this adapter never opens its own transaction.
 *
 * `addItem` is implemented as an `upsert` against `CartItem`'s existing `@@unique([cartId,
 * catalogProductId])` constraint (§11) — the DB constraint, not an insert-then-check race, is
 * cart mutations' actual concurrency-safety mechanism. No Catalog/Inventory business rules
 * (price/stock/Rx-classification revalidation) are applied here — the caller resolves those via
 * `ICatalogPort` before calling this repository (§0/§14).
 */
@Injectable()
export class PrismaCartRepository implements ICartRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findActiveByCustomer(customerUserId: string, tx?: unknown): Promise<CartSnapshot | null> {
    const row = await this.client(tx).cart.findFirst({
      where: { customerUserId, status: 'ACTIVE' },
      include: { items: true },
    });
    return row ? toCartSnapshot(row) : null;
  }

  async findById(cartId: string, tx?: unknown): Promise<CartSnapshot | null> {
    const row = await this.client(tx).cart.findUnique({
      where: { id: cartId },
      include: { items: true },
    });
    return row ? toCartSnapshot(row) : null;
  }

  async create(customerUserId: string, tx?: unknown): Promise<CartSnapshot> {
    const row = await this.client(tx).cart.create({
      data: { customerUserId },
      include: { items: true },
    });
    return toCartSnapshot(row);
  }

  async findItemById(cartItemId: string, tx?: unknown): Promise<CartItemSnapshot | null> {
    const row = await this.client(tx).cartItem.findUnique({ where: { id: cartItemId } });
    return row ? toCartItemSnapshot(row) : null;
  }

  async addItem(
    cartId: string,
    item: NewCartItemData,
    tx?: unknown,
  ): Promise<CartItemSnapshot> {
    const row = await this.client(tx).cartItem.upsert({
      where: { cartId_catalogProductId: { cartId, catalogProductId: item.catalogProductId } },
      create: {
        cartId,
        catalogProductId: item.catalogProductId,
        quantity: item.quantity,
        indicativePrice: item.indicativePrice ?? null,
        requiresRx: item.requiresRx ?? false,
      },
      update: {
        quantity: item.quantity,
        indicativePrice: item.indicativePrice ?? null,
        requiresRx: item.requiresRx ?? false,
      },
    });
    return toCartItemSnapshot(row);
  }

  async updateItemQuantity(
    cartItemId: string,
    quantity: number,
    tx?: unknown,
  ): Promise<CartItemSnapshot> {
    const row = await this.client(tx).cartItem.update({
      where: { id: cartItemId },
      data: { quantity },
    });
    return toCartItemSnapshot(row);
  }

  async reconcileItemPrice(
    cartItemId: string,
    indicativePrice: number | null,
    requiresRx: boolean,
    tx?: unknown,
  ): Promise<CartItemSnapshot> {
    const row = await this.client(tx).cartItem.update({
      where: { id: cartItemId },
      data: { indicativePrice, requiresRx },
    });
    return toCartItemSnapshot(row);
  }

  async removeItem(cartItemId: string, tx?: unknown): Promise<void> {
    await this.client(tx).cartItem.delete({ where: { id: cartItemId } });
  }

  async clearItems(cartId: string, tx?: unknown): Promise<void> {
    await this.client(tx).cartItem.deleteMany({ where: { cartId } });
  }

  async markConverted(cartId: string, tx?: unknown): Promise<void> {
    await this.client(tx).cart.update({ where: { id: cartId }, data: { status: 'CONVERTED' } });
  }
}
