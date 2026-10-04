import { PrismaCartRepository } from '../../src/modules/orders/infrastructure/persistence/prisma-cart.repository';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createPrisma, resetOrdersTables } from './support';

describe('PrismaCartRepository (e2e)', () => {
  let prisma: PrismaService;
  let repo: PrismaCartRepository;

  beforeAll(async () => {
    prisma = await createPrisma();
    repo = new PrismaCartRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetOrdersTables(prisma);
  });

  describe('create / findActiveByCustomer / findById', () => {
    it('creates an ACTIVE cart with no items and round-trips it', async () => {
      const created = await repo.create('customer-1');
      expect(created.id).toEqual(expect.any(String));
      expect(created.customerUserId).toBe('customer-1');
      expect(created.status).toBe('ACTIVE');
      expect(created.beneficiaryId).toBeNull();
      expect(created.items).toEqual([]);

      const found = await repo.findById(created.id);
      expect(found).toEqual(created);
    });

    it('findActiveByCustomer returns the ACTIVE cart, ignoring a CONVERTED one', async () => {
      const converted = await repo.create('customer-2');
      await repo.markConverted(converted.id);
      const active = await repo.create('customer-2');

      const found = await repo.findActiveByCustomer('customer-2');
      expect(found?.id).toBe(active.id);
    });

    it('returns null when the customer has no ACTIVE cart', async () => {
      await expect(repo.findActiveByCustomer('customer-none')).resolves.toBeNull();
    });

    it('returns null for an unknown cart id', async () => {
      await expect(repo.findById('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
    });
  });

  describe('addItem', () => {
    it('adds a new item and reflects it on the cart snapshot', async () => {
      const cart = await repo.create('customer-3');
      const item = await repo.addItem(cart.id, {
        catalogProductId: 'product-1',
        quantity: 2,
        indicativePrice: 5000,
        requiresRx: true,
      });

      expect(item.cartId).toBe(cart.id);
      expect(item.catalogProductId).toBe('product-1');
      expect(item.quantity).toBe(2);
      expect(item.indicativePrice).toBe(5000);
      expect(item.requiresRx).toBe(true);

      const found = await repo.findById(cart.id);
      expect(found?.items).toHaveLength(1);
      expect(found?.items[0]).toEqual(item);
    });

    it('applies defaults for optional fields', async () => {
      const cart = await repo.create('customer-3b');
      const item = await repo.addItem(cart.id, { catalogProductId: 'product-2', quantity: 1 });
      expect(item.indicativePrice).toBeNull();
      expect(item.requiresRx).toBe(false);
    });

    it('upserts against @@unique([cartId, catalogProductId]) instead of duplicating a row (§11)', async () => {
      const cart = await repo.create('customer-4');
      await repo.addItem(cart.id, { catalogProductId: 'product-3', quantity: 1 });
      const upserted = await repo.addItem(cart.id, {
        catalogProductId: 'product-3',
        quantity: 5,
        indicativePrice: 999,
      });

      expect(upserted.quantity).toBe(5);
      const found = await repo.findById(cart.id);
      expect(found?.items).toHaveLength(1);
      expect(found?.items[0].quantity).toBe(5);
    });
  });

  describe('findItemById / updateItemQuantity / removeItem', () => {
    it('finds a single item by id', async () => {
      const cart = await repo.create('customer-5');
      const item = await repo.addItem(cart.id, { catalogProductId: 'product-4', quantity: 1 });
      const found = await repo.findItemById(item.id);
      expect(found).toEqual(item);
    });

    it('returns null for an unknown item id', async () => {
      await expect(repo.findItemById('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
    });

    it('updates the quantity of an existing item', async () => {
      const cart = await repo.create('customer-6');
      const item = await repo.addItem(cart.id, { catalogProductId: 'product-5', quantity: 1 });
      const updated = await repo.updateItemQuantity(item.id, 9);
      expect(updated.quantity).toBe(9);
    });

    it('removes a single item, leaving the rest of the cart intact', async () => {
      const cart = await repo.create('customer-7');
      const keep = await repo.addItem(cart.id, { catalogProductId: 'product-6', quantity: 1 });
      const remove = await repo.addItem(cart.id, { catalogProductId: 'product-7', quantity: 1 });

      await repo.removeItem(remove.id);

      const found = await repo.findById(cart.id);
      expect(found?.items).toHaveLength(1);
      expect(found?.items[0].id).toBe(keep.id);
    });
  });

  describe('clearItems', () => {
    it('removes every item but keeps the cart itself ACTIVE (DELETE /cart, §9.1)', async () => {
      const cart = await repo.create('customer-8');
      await repo.addItem(cart.id, { catalogProductId: 'product-8', quantity: 1 });
      await repo.addItem(cart.id, { catalogProductId: 'product-9', quantity: 2 });

      await repo.clearItems(cart.id);

      const found = await repo.findById(cart.id);
      expect(found?.status).toBe('ACTIVE');
      expect(found?.items).toEqual([]);
    });
  });

  describe('markConverted', () => {
    it('flips status to CONVERTED so a subsequent findActiveByCustomer starts a fresh cart', async () => {
      const cart = await repo.create('customer-9');
      await repo.markConverted(cart.id);

      const found = await repo.findById(cart.id);
      expect(found?.status).toBe('CONVERTED');
      await expect(repo.findActiveByCustomer('customer-9')).resolves.toBeNull();
    });
  });

  describe('transaction client (tx?: unknown) handling', () => {
    it('participates in the caller-supplied transaction: a rollback discards the write', async () => {
      let cartId: string | undefined;
      await expect(
        prisma.$transaction(async (tx) => {
          const cart = await repo.create('customer-tx-1', tx);
          cartId = cart.id;
          await repo.addItem(cart.id, { catalogProductId: 'product-tx-1', quantity: 1 }, tx);
          const seenInTx = await repo.findById(cart.id, tx);
          expect(seenInTx?.items).toHaveLength(1);
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      await expect(repo.findById(cartId!)).resolves.toBeNull();
    });

    it('commits normally when the transaction succeeds', async () => {
      const cartId = await prisma.$transaction(async (tx) => {
        const cart = await repo.create('customer-tx-2', tx);
        await repo.addItem(cart.id, { catalogProductId: 'product-tx-2', quantity: 3 }, tx);
        return cart.id;
      });

      const found = await repo.findById(cartId);
      expect(found?.items).toHaveLength(1);
      expect(found?.items[0].quantity).toBe(3);
    });
  });
});
