import { Inject, Injectable } from '@nestjs/common';
import { DeliveryErrors } from '../../domain/errors';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import { IOrdersPort, ORDERS_PORT } from '../ports/outbound/orders.port';

/** Which party a request was authorized as. Recorded so callers can log and shape a response. */
export enum DeliveryViewer {
  Customer = 'CUSTOMER',
  Driver = 'DRIVER',
}

/** The fields an access decision is made from. Deliberately not the whole aggregate. */
export interface DeliveryAccessSubject {
  id: string;
  orderId: string;
  assignedDriverId: string | null;
}

/**
 * Who may look at a delivery (§9.4's "Auth: order ownership", §12 of the PoD brief).
 *
 * ## One decision, every customer-facing read
 *
 * The tracking snapshot, the ETA that rides on it, and now the proof-of-delivery read all ask this
 * and nothing else. That is the point: each of those works was told not to create a second
 * authorization path, and the way second paths actually appear is that a new read copies the
 * previous one's checks and the two then drift — one gaining a role the other never hears about,
 * or losing a check nobody notices. A customer refused a delivery's position must not be able to
 * see the photograph of their neighbour's doorstep, and the only durable way to guarantee that is
 * for there to be one function that decides.
 *
 * ## Two parties, both proved
 *
 *  - **The customer who owns the order**, established by asking Module 06 who that is and
 *    comparing it to the subject resolved from the access token. The client supplies an id and no
 *    claim about who they are; there is no parameter through which such a claim could arrive.
 *  - **The driver currently carrying it**, whose `driver_profiles.id` must equal the job's
 *    `assignedDriverId`. A driver reassigned off a job loses access at the same instant they lose
 *    the job, because it is the same fact.
 *
 * ## No administrative path, and that is deliberate
 *
 * §12 of the PoD brief allows for operations roles "if an existing permission exists", and none
 * does: the RBAC catalogue has carried no `delivery:*:any` key and no admin delivery grant since
 * Phase 0, which is the same reason the dispatch work declined to build §9.5's admin reassign
 * route. Inventing a permission in order to satisfy a conditional clause would put an RBAC grant
 * in the catalogue ahead of the surface it guards and ahead of anybody deciding who should hold
 * it. The work that adds the admin delivery console adds the key, deliberately, and this service
 * gains a third branch then.
 *
 * ## Everybody else gets `NOT_FOUND`
 *
 * Never `FORBIDDEN`. A distinguishable "that exists but is not yours" turns job and order ids into
 * an oracle for who has ordered medicines and when, which for a pharmacy is a disclosure that
 * matters far more than usual (`00-shared-conventions.md` §1).
 */
@Injectable()
export class DeliveryAccessService {
  constructor(
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(ORDERS_PORT) private readonly orders: IOrdersPort,
  ) {}

  /**
   * Resolves the caller's relationship to a delivery, or refuses.
   *
   * `requestedId` is what the caller named — a job id or an order id — and is echoed into the
   * not-found so a legitimate client can see which of its identifiers failed, without the answer
   * differing between "absent" and "not yours".
   */
  async resolve(
    job: DeliveryAccessSubject,
    userId: string,
    requestedId: string,
  ): Promise<DeliveryViewer> {
    // The driver check is first and is cheap — one indexed read of a row we may need anyway — and
    // it avoids asking Module 06 about an order on behalf of somebody who is plainly the driver
    // rather than the buyer.
    const profile = job.assignedDriverId ? await this.profiles.findByUserId(userId) : null;
    if (profile !== null && profile.id === job.assignedDriverId) {
      return DeliveryViewer.Driver;
    }

    const owner = await this.orders.getOrderCustomerUserId(job.orderId);
    if (owner === null || owner !== userId) {
      throw DeliveryErrors.notFound('Delivery job not found.', { id: requestedId });
    }
    return DeliveryViewer.Customer;
  }
}
