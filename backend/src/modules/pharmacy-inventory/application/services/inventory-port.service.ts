import { Injectable } from '@nestjs/common';
import { ConfirmReservationCommand } from '../commands/confirm-reservation.command';
import { DispatchStockCommand } from '../commands/dispatch-stock.command';
import { ReleaseReservationCommand } from '../commands/release-reservation.command';
import { ReserveStockCommand } from '../commands/reserve-stock.command';
import { GetReservationFulfillmentQuery } from '../queries/get-reservation-fulfillment.query';
import {
  IInventoryPort,
  ReservationFulfillmentView,
  ReserveStockInput,
  ReserveStockResult,
} from '../ports/inbound/inventory.port';

/**
 * `IInventoryPort` implementation (module-04 §10.3, §11, §14.6) — the module's own exported
 * contract, provided to other in-process modules (Module 06, later) via Nest DI. Never routed
 * through this module's own HTTP layer.
 */
@Injectable()
export class InventoryPortService implements IInventoryPort {
  constructor(
    private readonly reserveStock: ReserveStockCommand,
    private readonly confirmReservation: ConfirmReservationCommand,
    private readonly releaseReservation: ReleaseReservationCommand,
    private readonly dispatchStock: DispatchStockCommand,
    private readonly getReservationFulfillmentQuery: GetReservationFulfillmentQuery,
  ) {}

  reserve(input: ReserveStockInput): Promise<ReserveStockResult> {
    return this.reserveStock.execute(input);
  }

  confirm(input: { reservationId: string }): Promise<void> {
    return this.confirmReservation.execute(input);
  }

  release(input: { reservationId: string; reason?: string }): Promise<void> {
    return this.releaseReservation.execute(input);
  }

  dispatch(input: { reservationId: string; actorUserId?: string }): Promise<void> {
    return this.dispatchStock.execute(input);
  }

  getReservationFulfillment(reservationId: string): Promise<ReservationFulfillmentView> {
    return this.getReservationFulfillmentQuery.execute(reservationId);
  }
}
