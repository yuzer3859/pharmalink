import { DeliveryJobStatus } from '../domain/enums';
import { DeliveryPaperState } from '../domain/repositories/delivery-paper.repository';
import { paperRoundTripProblem } from './commands/record-paper-collected.command';

const paper = (over: Partial<DeliveryPaperState> = {}): DeliveryPaperState => ({
  jobId: 'job-1',
  orderId: 'order-1',
  fulfillmentId: 'f-1',
  status: 'ASSIGNED',
  assignedDriverId: 'driver-1',
  paperRxRequired: true,
  paperCollectedAt: null,
  goodsReadyAt: null,
  ...over,
});

describe('paperRoundTripProblem (Work 136)', () => {
  it('leaves a job without the paper alone', () => {
    for (const to of [DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP]) {
      expect(paperRoundTripProblem(paper({ paperRxRequired: false }), to)).toBeNull();
      expect(paperRoundTripProblem(null, to)).toBeNull();
    }
  });

  it('needs the paper collected before the pharmacy, and the medicine ready before the pick-up', () => {
    expect(paperRoundTripProblem(paper(), DeliveryJobStatus.ARRIVED_PICKUP)).toMatch(/paper prescription from the customer/);
    expect(paperRoundTripProblem(paper({ paperCollectedAt: new Date() }), DeliveryJobStatus.ARRIVED_PICKUP)).toBeNull();
    expect(paperRoundTripProblem(paper({ paperCollectedAt: new Date() }), DeliveryJobStatus.PICKED_UP)).toMatch(/not marked the order ready/);
    expect(paperRoundTripProblem(paper({ paperCollectedAt: new Date(), goodsReadyAt: new Date() }), DeliveryJobStatus.PICKED_UP)).toBeNull();
    // Later legs are not the paper's concern.
    expect(paperRoundTripProblem(paper(), DeliveryJobStatus.EN_ROUTE)).toBeNull();
  });
});
