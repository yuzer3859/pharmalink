import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Product } from '../../domain/entities/product.entity';
import { ProductStatus, ProductType, RxClassification } from '../../domain/enums';
import { ICategoryRepository } from '../../domain/repositories/category.repository';
import { IProductRepository } from '../../domain/repositories/product.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { ChangeProductStatusCommand } from './change-product-status.command';

function build(product: Product) {
  const products: jest.Mocked<IProductRepository> = {
    findById: jest.fn().mockResolvedValue(product),
    create: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    setCategories: jest.fn(),
    categoryIdsFor: jest.fn().mockResolvedValue([]),
    findDuplicateCandidate: jest.fn(),
    search: jest.fn(),
    listByCategory: jest.fn(),
    countByCategoryId: jest.fn(),
  };
  const categories: jest.Mocked<ICategoryRepository> = {
    findById: jest.fn(),
    findBySlug: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    listActive: jest.fn(),
    listAll: jest.fn(),
    getAncestorChain: jest.fn(),
    findManyByIds: jest.fn().mockResolvedValue([]),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new ChangeProductStatusCommand(products, categories, uow, audit, outbox);
  return { command, products, audit, outbox };
}

function newProduct(status: ProductStatus = ProductStatus.DRAFT): Product {
  const product = Product.create('p-1', {
    type: ProductType.MEDICINE,
    genericName: 'Amoxicillin',
    manufacturerId: 'mfr-1',
    rxClassification: RxClassification.RX,
    nameEn: 'Amoxicillin 500mg',
  });
  if (status !== ProductStatus.DRAFT) {
    // Published only through review (module-16 Work 30).
    product.transitionStatus(ProductStatus.PENDING_REVIEW);
    if (status !== ProductStatus.PENDING_REVIEW) {
      product.transitionStatus(ProductStatus.ACTIVE);
      if (status !== ProductStatus.ACTIVE) {
        product.transitionStatus(status);
      }
    }
  }
  return product;
}

describe('ChangeProductStatusCommand', () => {
  it('rejects DRAFT -> ACTIVE directly (422; module-16 Work 30) — nothing saved, audited or published', async () => {
    const product = newProduct(ProductStatus.DRAFT);
    const { command, products, audit, outbox } = build(product);
    await expect(
      command.execute({ actorUserId: 'admin-1', productId: 'p-1', status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'INVALID_PRODUCT_STATUS_TRANSITION' });
    expect(products.save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('allows DRAFT -> PENDING_REVIEW and PENDING_REVIEW -> ACTIVE', async () => {
    const submitted = await build(newProduct(ProductStatus.DRAFT)).command.execute({ actorUserId: 'admin-1', productId: 'p-1', status: 'PENDING_REVIEW' });
    expect(submitted.status).toBe('PENDING_REVIEW');
    const approved = await build(newProduct(ProductStatus.PENDING_REVIEW)).command.execute({ actorUserId: 'admin-1', productId: 'p-1', status: 'ACTIVE' });
    expect(approved.status).toBe('ACTIVE');
  });

  it('rejects DELISTED -> ACTIVE directly (422)', async () => {
    const product = newProduct(ProductStatus.DELISTED);
    const { command } = build(product);
    await expect(
      command.execute({ actorUserId: 'admin-1', productId: 'p-1', status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'INVALID_PRODUCT_STATUS_TRANSITION' });
  });

  it('allows DELISTED -> DRAFT (§14.3 recovery transition)', async () => {
    const product = newProduct(ProductStatus.DELISTED);
    const { command } = build(product);
    const result = await command.execute({ actorUserId: 'admin-1', productId: 'p-1', status: 'DRAFT' });
    expect(result.status).toBe('DRAFT');
  });

  it('404s for a missing product', async () => {
    const { command, products } = build(newProduct());
    products.findById.mockResolvedValue(null);
    await expect(
      command.execute({ actorUserId: 'admin-1', productId: 'missing', status: 'ACTIVE' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('writes an audit entry and a ProductStatusChanged event with from/to/reason', async () => {
    const product = newProduct(ProductStatus.PENDING_REVIEW);
    const { command, audit, outbox } = build(product);
    await command.execute({ actorUserId: 'admin-1', productId: 'p-1', status: 'ACTIVE', reason: 'Reviewed' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PRODUCT_STATUS_CHANGED',
        context: { from: 'PENDING_REVIEW', to: 'ACTIVE', reason: 'Reviewed' },
      }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });
});
