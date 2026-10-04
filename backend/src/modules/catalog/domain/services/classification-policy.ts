import { CatalogErrors } from '../errors';
import { ControlledSchedule, ProductType, RxClassification } from '../enums';

/**
 * Pure, framework-free home for the Rx/controlled-substance invariants (module-03 §3.5, §3.6
 * invariants 1/2). Commands call into this rather than re-implementing the checks inline —
 * mirrors Module 02's `GeoPoint.withinEthiopia` pattern for BRULE-21.
 */
export const ClassificationPolicy = {
  /**
   * §3.6 invariant 1: a `MEDICINE` product must carry a non-null `rxClassification`; a
   * `HEALTH_PRODUCT` must not carry one at all.
   */
  assertValidClassification(type: ProductType, rxClassification: RxClassification | null): void {
    if (type === ProductType.MEDICINE && rxClassification == null) {
      throw CatalogErrors.validation('rxClassification is required for MEDICINE products.', {
        field: 'rxClassification',
      });
    }
    if (type === ProductType.HEALTH_PRODUCT && rxClassification != null) {
      throw CatalogErrors.invalidClassification(
        'HEALTH_PRODUCT items must not carry an Rx classification.',
        { field: 'rxClassification' },
      );
    }
  },

  /**
   * §3.6 invariant 8 (resolved by Architect review, §14.6): a `MEDICINE` product must carry a
   * non-null `manufacturerId`, closing the NULL-collision gap in the dedup partial unique index
   * (§6.2). `HEALTH_PRODUCT` rows may omit it.
   */
  assertManufacturerRequirement(type: ProductType, manufacturerId: string | null): void {
    if (type === ProductType.MEDICINE && !manufacturerId) {
      throw CatalogErrors.validation('manufacturerId is required for MEDICINE products.', {
        field: 'manufacturerId',
      });
    }
  },

  /**
   * §3.6 invariant 2: `onlineSaleProhibited` is server-computed only — `true` iff
   * `controlledSchedule = PROHIBITED` — never independently client-settable (mirrors Module 02's
   * `isWithinEthiopia` pattern).
   */
  deriveOnlineSaleProhibited(controlledSchedule: ControlledSchedule): boolean {
    return controlledSchedule === ControlledSchedule.PROHIBITED;
  },
};
