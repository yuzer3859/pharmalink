import { Inject, Injectable } from '@nestjs/common';
import { PharmacyInventoryErrors } from '../../domain/errors';
import {
  IReservationRepository,
  RESERVATION_REPOSITORY,
} from '../../domain/repositories/reservation.repository';
import { ReservationFulfillmentView } from '../ports/inbound/inventory.port';

/**
 * `IInventoryPort.getReservationFulfillment` (module-04 §8, §14.7) — answers "has this
 * reservation's stock physically left the pharmacy" via a read join to `DISPATCH` movements,
 * rather than widening the `ReservationStatus` enum.
 */
@Injectable()
export class GetReservationFulfillmentQuery {
  constructor(
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepository,
  ) {}

  async execute(reservationId: string): Promise<ReservationFulfillmentView> {
    const reservation = await this.reservations.findById(reservationId);
    if (!reservation) {
      throw PharmacyInventoryErrors.reservationNotFound();
    }
    const dispatches = await this.reservations.findDispatchMovements(reservationId);
    const dispatchedQuantity = dispatches.reduce((sum, d) => sum + d.qty, 0);
    return {
      reservationId,
      status: reservation.status,
      dispatched: dispatches.length > 0,
      dispatchedQuantity,
    };
  }
}
