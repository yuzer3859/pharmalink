import { ControlledSchedule, ProductType, RxClassification } from '../enums';
import { ClassificationPolicy } from './classification-policy';

describe('ClassificationPolicy', () => {
  describe('assertValidClassification', () => {
    it('rejects a MEDICINE with no rxClassification', () => {
      expect(() =>
        ClassificationPolicy.assertValidClassification(ProductType.MEDICINE, null),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('accepts a MEDICINE with rxClassification', () => {
      expect(() =>
        ClassificationPolicy.assertValidClassification(ProductType.MEDICINE, RxClassification.RX),
      ).not.toThrow();
    });

    it('rejects a HEALTH_PRODUCT that carries an rxClassification', () => {
      expect(() =>
        ClassificationPolicy.assertValidClassification(
          ProductType.HEALTH_PRODUCT,
          RxClassification.OTC,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CLASSIFICATION' }));
    });

    it('accepts a HEALTH_PRODUCT with no rxClassification', () => {
      expect(() =>
        ClassificationPolicy.assertValidClassification(ProductType.HEALTH_PRODUCT, null),
      ).not.toThrow();
    });
  });

  describe('assertManufacturerRequirement', () => {
    it('rejects a MEDICINE with no manufacturerId', () => {
      expect(() =>
        ClassificationPolicy.assertManufacturerRequirement(ProductType.MEDICINE, null),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    });

    it('accepts a MEDICINE with a manufacturerId', () => {
      expect(() =>
        ClassificationPolicy.assertManufacturerRequirement(ProductType.MEDICINE, 'mfr-1'),
      ).not.toThrow();
    });

    it('accepts a HEALTH_PRODUCT with no manufacturerId', () => {
      expect(() =>
        ClassificationPolicy.assertManufacturerRequirement(ProductType.HEALTH_PRODUCT, null),
      ).not.toThrow();
    });
  });

  describe('deriveOnlineSaleProhibited', () => {
    it('is true iff controlledSchedule = PROHIBITED', () => {
      expect(ClassificationPolicy.deriveOnlineSaleProhibited(ControlledSchedule.PROHIBITED)).toBe(
        true,
      );
      expect(ClassificationPolicy.deriveOnlineSaleProhibited(ControlledSchedule.NONE)).toBe(false);
      expect(ClassificationPolicy.deriveOnlineSaleProhibited(ControlledSchedule.SCHEDULE_2)).toBe(
        false,
      );
    });
  });
});
