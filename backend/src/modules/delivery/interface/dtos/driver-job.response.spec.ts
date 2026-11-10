import { PodRequirement } from '../../domain/services/proof-of-delivery-policy';
import { deliveryRulesFor, DriverJobRuleSettings } from './driver-job.response';

const settings = (over: Partial<DriverJobRuleSettings['pod']> = {}, cod: Partial<DriverJobRuleSettings['cod']> = {}): DriverJobRuleSettings => ({
  pod: { base: PodRequirement.None, coldChain: PodRequirement.None, cod: PodRequirement.None, ...over },
  cod: { requireExactAmount: false, requireCollectionForCompletion: false, ...cod },
});

describe('deliveryRulesFor (Work 121)', () => {
  it('demands nothing under the shipped settings', () => {
    expect(deliveryRulesFor({ isCod: true, isColdChain: true }, settings())).toEqual({
      podRequirement: 'NONE',
      codCollectionRequired: false,
      codExactAmountRequired: false,
    });
  });

  it('takes the strictest PoD rule that applies to the job', () => {
    const s = settings({ base: PodRequirement.Confirmation, cod: PodRequirement.Artifact });
    expect(deliveryRulesFor({ isCod: true, isColdChain: false }, s).podRequirement).toBe('ARTIFACT');
    expect(deliveryRulesFor({ isCod: false, isColdChain: false }, s).podRequirement).toBe('CONFIRMATION');
    expect(deliveryRulesFor({ isCod: false, isColdChain: true }, settings({ coldChain: PodRequirement.Artifact })).podRequirement).toBe('ARTIFACT');
  });

  it('asks for the COD collection, and the exact amount, only on a COD job', () => {
    const s = settings({}, { requireCollectionForCompletion: true, requireExactAmount: true });
    expect(deliveryRulesFor({ isCod: true, isColdChain: false }, s)).toMatchObject({ codCollectionRequired: true, codExactAmountRequired: true });
    expect(deliveryRulesFor({ isCod: false, isColdChain: false }, s)).toMatchObject({ codCollectionRequired: false, codExactAmountRequired: false });
  });
});
