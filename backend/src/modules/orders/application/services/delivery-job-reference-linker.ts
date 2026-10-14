import {
  DeliveryJobLinkInput,
  DeliveryJobLinkOutcome,
  IFulfillmentDeliveryJobLinkRepository,
} from '../../domain/repositories/fulfillment-delivery-job-link.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `INVALID` — an id was missing or not a UUID; nothing was written. */
export type DeliveryJobReferenceResult = DeliveryJobLinkOutcome | 'INVALID';

/**
 * **The** rule for recording a Module 08 job on a Module 06 fulfillment, shared by every writer:
 * `DeliveryJobCreatedHandler` (the event path) and `DeliveryJobReferenceReconciler` (the periodic
 * recovery path). Validate the three ids, then the guarded compare-and-set of
 * `IFulfillmentDeliveryJobLinkRepository.link` — null is filled, the same job is a no-op, a different
 * job is a `CONFLICT` and never overwritten, another order's fulfillment is an `ORDER_MISMATCH`.
 * One implementation, so the two paths cannot drift into different conflict rules.
 */
export async function linkDeliveryJobReference(
  links: IFulfillmentDeliveryJobLinkRepository,
  input: Partial<DeliveryJobLinkInput>,
): Promise<DeliveryJobReferenceResult> {
  const { fulfillmentId, orderId, deliveryJobId } = input;
  if (![fulfillmentId, orderId, deliveryJobId].every((v) => typeof v === 'string' && UUID.test(v))) {
    return 'INVALID';
  }
  return links.link({ fulfillmentId: fulfillmentId!, orderId: orderId!, deliveryJobId: deliveryJobId! });
}
