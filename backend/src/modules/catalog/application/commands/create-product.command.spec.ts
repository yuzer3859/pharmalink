import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Manufacturer } from '../../domain/entities/manufacturer.entity';
import { ProductType } from '../../domain/enums';
import { ICategoryRepository } from '../../domain/repositories/category.repository';
import { IManufacturerRepository } from '../../domain/repositories/manufacturer.repository';
import { IProductRepository } from '../../domain/repositories/product.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { PRODUCT_DEDUP_INDEX } from '../support/dedup-conflict';
import { CreateProductCommand } from './create-product.command';

function uniqueViolation(): Error & { code: string; meta: { target: string } } {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: PRODUCT_DEDUP_INDEX },
  });
}

function build() {
  const manufacturer = Manufacturer.create('mfr-1', { name: 'Acme Pharma' });
  const products: jest.Mocked<IProductRepository> = {
    findById: jest.fn(),
    create: jest.fn().mockResolvedValue(undefined),
    save: jest.fn(),
    setCategories: jest.fn().mockResolvedValue(undefined),
    categoryIdsFor: jest.fn().mockResolvedValue([]),
    findDuplicateCandidate: jest.fn().mockResolvedValue(null),
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
  const manufacturers: jest.Mocked<IManufacturerRepository> = {
    findById: jest.fn().mockResolvedValue(manufacturer),
    findByName: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    list: jest.fn(),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new CreateProductCommand(products, categories, manufacturers, uow, audit, outbox);
  return { command, products, categories, manufacturers, audit, outbox };
}

function medicineInput(overrides: Record<string, unknown> = {}) {
  return {
    actorUserId: 'admin-1',
    type: ProductType.MEDICINE,
    genericName: 'Amoxicillin',
    manufacturerId: 'mfr-1',
    rxClassification: 'RX',
    nameEn: 'Amoxicillin 500mg',
    ...overrides,
  };
}

describe('CreateProductCommand', () => {
  it('creates a valid MEDICINE product', async () => {
    const { command, products } = build();
    const result = await command.execute(medicineInput());
    expect(result.type).toBe(ProductType.MEDICINE);
    expect(result.status).toBe('DRAFT');
    expect(products.create).toHaveBeenCalledTimes(1);
  });

  it('persists the reference price it was given and returns it in the detail view', async () => {
    const { command, products } = build();

    const result = await command.execute(medicineInput({ price: 2500 }));

    expect(result.price).toBe(2500);
    const persisted = (products.create as jest.Mock).mock.calls[0][0];
    expect(persisted.toProps().price).toBe(2500);
  });

  it('leaves the price null when none is given (unpriced, not free)', async () => {
    const { command } = build();
    expect((await command.execute(medicineInput())).price).toBeNull();
  });

  it('rejects a floating-point price in the domain, not just the DTO', async () => {
    const { command, products } = build();
    await expect(command.execute(medicineInput({ price: 25.5 }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(products.create).not.toHaveBeenCalled();
  });

  it('404s when manufacturerId does not exist', async () => {
    const { command, manufacturers } = build();
    manufacturers.findById.mockResolvedValue(null);
    await expect(command.execute(medicineInput())).rejects.toMatchObject({
      code: 'MANUFACTURER_NOT_FOUND',
    });
  });

  it('404s when a categoryId does not exist', async () => {
    const { command, categories } = build();
    categories.findManyByIds.mockResolvedValue([]);
    await expect(
      command.execute(medicineInput({ categoryIds: ['00000000-0000-0000-0000-000000000001'] })),
    ).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND' });
  });

  it('rejects a MEDICINE with no rxClassification (422 VALIDATION_ERROR)', async () => {
    const { command } = build();
    await expect(
      command.execute(medicineInput({ rxClassification: undefined })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a MEDICINE with no manufacturerId (422 VALIDATION_ERROR, §14.6)', async () => {
    const { command } = build();
    await expect(
      command.execute(medicineInput({ manufacturerId: undefined })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a duplicate MEDICINE with the candidate id surfaced (409)', async () => {
    const { command, products } = build();
    products.findDuplicateCandidate.mockResolvedValue('existing-product-id');
    await expect(command.execute(medicineInput())).rejects.toMatchObject({
      code: 'CATALOG_DUPLICATE_PRODUCT',
      details: { productId: 'existing-product-id' },
    });
  });

  it('writes an audit entry and a ProductCreated event', async () => {
    const { command, audit, outbox } = build();
    await command.execute(medicineInput());
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRODUCT_CREATED', resourceType: 'Product' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('retries the insert when the medicine dedup partial unique index rejects a losing commit', async () => {
    const { command, products } = build();
    (products.create as jest.Mock).mockRejectedValueOnce(uniqueViolation()).mockResolvedValueOnce(undefined);

    const result = await command.execute(medicineInput());

    expect(result).toBeDefined();
    expect(products.create).toHaveBeenCalledTimes(2);
    expect(products.findDuplicateCandidate).toHaveBeenCalledTimes(2); // re-evaluated on retry
  });

  it('gives up with a defined CONFLICT (never a 500) if contention never resolves', async () => {
    const { command, products } = build();
    (products.create as jest.Mock).mockRejectedValue(uniqueViolation());
    await expect(command.execute(medicineInput())).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rethrows a non-conflict persistence error unchanged (no retry)', async () => {
    const { command, products } = build();
    const boom = new Error('disk full');
    (products.create as jest.Mock).mockRejectedValue(boom);
    await expect(command.execute(medicineInput())).rejects.toBe(boom);
    expect(products.create).toHaveBeenCalledTimes(1);
  });

  it('creates a HEALTH_PRODUCT with no manufacturerId/rxClassification and skips dedup entirely', async () => {
    const { command, products } = build();
    const result = await command.execute({
      actorUserId: 'admin-1',
      type: ProductType.HEALTH_PRODUCT,
      brandName: 'Vitamin C',
    });
    expect(result.type).toBe(ProductType.HEALTH_PRODUCT);
    expect(products.findDuplicateCandidate).not.toHaveBeenCalled();
  });
});
