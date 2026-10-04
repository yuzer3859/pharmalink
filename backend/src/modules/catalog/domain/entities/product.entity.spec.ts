import { Product } from './product.entity';
import { ControlledSchedule, ProductStatus, ProductType, RxClassification } from '../enums';

function validMedicineInput(overrides: Record<string, unknown> = {}) {
  return {
    type: ProductType.MEDICINE,
    genericName: 'Amoxicillin',
    manufacturerId: 'mfr-1',
    rxClassification: RxClassification.RX,
    nameEn: 'Amoxicillin 500mg',
    ...overrides,
  };
}

describe('Product entity', () => {
  describe('create', () => {
    it('creates a MEDICINE with valid classification and manufacturer', () => {
      const product = Product.create('p-1', validMedicineInput());
      expect(product.status).toBe(ProductStatus.DRAFT);
      expect(product.toProps().onlineSaleProhibited).toBe(false);
    });

    it('rejects a MEDICINE with no rxClassification', () => {
      expect(() =>
        Product.create('p-1', validMedicineInput({ rxClassification: undefined })),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('rejects a MEDICINE with no manufacturerId (§3.6 invariant 8)', () => {
      expect(() =>
        Product.create('p-1', validMedicineInput({ manufacturerId: undefined })),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('accepts a HEALTH_PRODUCT with no manufacturerId and no rxClassification', () => {
      const product = Product.create('p-1', {
        type: ProductType.HEALTH_PRODUCT,
        brandName: 'Vitamin C',
      });
      expect(product.toProps().manufacturerId).toBeNull();
    });

    it('rejects a HEALTH_PRODUCT that carries an rxClassification', () => {
      expect(() =>
        Product.create('p-1', {
          type: ProductType.HEALTH_PRODUCT,
          brandName: 'Vitamin C',
          rxClassification: RxClassification.OTC,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CLASSIFICATION' }));
    });

    it('rejects a product with neither nameEn nor brandName', () => {
      expect(() =>
        Product.create('p-1', validMedicineInput({ nameEn: undefined })),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('forces onlineSaleProhibited = true when controlledSchedule = PROHIBITED, regardless of caller intent', () => {
      const product = Product.create(
        'p-1',
        validMedicineInput({ controlledSchedule: ControlledSchedule.PROHIBITED }),
      );
      expect(product.toProps().onlineSaleProhibited).toBe(true);
    });
  });

  describe('applyEdits', () => {
    it('re-validates classification when rxClassification changes', () => {
      const product = Product.create('p-1', validMedicineInput());
      expect(() => product.applyEdits({ rxClassification: null })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    });

    it('re-validates manufacturer requirement when manufacturerId is cleared', () => {
      const product = Product.create('p-1', validMedicineInput());
      expect(() => product.applyEdits({ manufacturerId: null })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    });

    it('re-derives onlineSaleProhibited when controlledSchedule changes', () => {
      const product = Product.create('p-1', validMedicineInput());
      product.applyEdits({ controlledSchedule: ControlledSchedule.PROHIBITED });
      expect(product.toProps().onlineSaleProhibited).toBe(true);
    });

    it('returns an empty changed-fields list and no-ops when nothing is provided', () => {
      const product = Product.create('p-1', validMedicineInput());
      expect(product.applyEdits({})).toEqual([]);
    });

    it('rejects clearing both nameEn and brandName', () => {
      const product = Product.create('p-1', validMedicineInput({ brandName: undefined }));
      expect(() => product.applyEdits({ nameEn: null })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    });
  });

  describe('price (reference price, ETB minor units — 00-shared-conventions §11)', () => {
    it('defaults to null — an unpriced product is "not purchasable", never free', () => {
      expect(Product.create('p-1', validMedicineInput()).toProps().price).toBeNull();
    });

    it('stores an integer minor-unit price given at create time', () => {
      expect(Product.create('p-1', validMedicineInput({ price: 2500 })).toProps().price).toBe(2500);
    });

    it('accepts zero (a legitimately free product) but rejects a negative price', () => {
      expect(Product.create('p-1', validMedicineInput({ price: 0 })).toProps().price).toBe(0);
      expect(() => Product.create('p-1', validMedicineInput({ price: -1 }))).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    });

    it('rejects a floating-point price — money is never a float', () => {
      expect(() => Product.create('p-1', validMedicineInput({ price: 25.5 }))).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    });

    it('applyEdits repoints the price and reports it as a changed field', () => {
      const product = Product.create('p-1', validMedicineInput({ price: 2500 }));
      expect(product.applyEdits({ price: 3100 })).toContain('price');
      expect(product.toProps().price).toBe(3100);
    });

    it('applyEdits re-validates the price and leaves an untouched price alone', () => {
      const product = Product.create('p-1', validMedicineInput({ price: 2500 }));
      expect(() => product.applyEdits({ price: 12.75 })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
      expect(product.applyEdits({ nameEn: 'Renamed' })).not.toContain('price');
      expect(product.toProps().price).toBe(2500);
    });
  });

  describe('transitionStatus', () => {
    it('allows DRAFT -> ACTIVE', () => {
      const product = Product.create('p-1', validMedicineInput());
      product.transitionStatus(ProductStatus.ACTIVE);
      expect(product.status).toBe(ProductStatus.ACTIVE);
    });

    it('rejects DELISTED -> ACTIVE directly, but allows DELISTED -> DRAFT (§14.3)', () => {
      const product = Product.create('p-1', validMedicineInput());
      product.transitionStatus(ProductStatus.ACTIVE);
      product.transitionStatus(ProductStatus.DELISTED);

      expect(() => product.transitionStatus(ProductStatus.ACTIVE)).toThrow(
        expect.objectContaining({ code: 'INVALID_PRODUCT_STATUS_TRANSITION' }),
      );
      product.transitionStatus(ProductStatus.DRAFT);
      expect(product.status).toBe(ProductStatus.DRAFT);
    });
  });
});
