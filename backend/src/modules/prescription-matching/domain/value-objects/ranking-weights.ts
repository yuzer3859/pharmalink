import { PrescriptionMatchingErrors } from '../errors';

export interface RankingWeightsProps {
  distanceWeight: number;
  priceWeight: number;
}

/**
 * `{ distanceWeight, priceWeight }` wrapper (module-05 §3.8) — deliberately has no rating term
 * in Slice 1 (§0.2/§18.1 regression requirement: Module 15/Reviews does not exist yet). Read via
 * `IConfigPort` key `matching.rankingWeights` at the application layer (not implemented in this
 * task); this VO only guards against a garbage config value (non-finite/negative weights), it
 * does not supply a default itself.
 */
export class RankingWeights {
  private constructor(
    readonly distanceWeight: number,
    readonly priceWeight: number,
  ) {}

  static of(props: RankingWeightsProps): RankingWeights {
    if (!RankingWeights.isValidWeight(props.distanceWeight)) {
      throw PrescriptionMatchingErrors.validation(
        'distanceWeight must be a non-negative finite number.',
        { field: 'distanceWeight' },
      );
    }
    if (!RankingWeights.isValidWeight(props.priceWeight)) {
      throw PrescriptionMatchingErrors.validation(
        'priceWeight must be a non-negative finite number.',
        { field: 'priceWeight' },
      );
    }
    return new RankingWeights(props.distanceWeight, props.priceWeight);
  }

  private static isValidWeight(value: number): boolean {
    return Number.isFinite(value) && value >= 0;
  }
}
