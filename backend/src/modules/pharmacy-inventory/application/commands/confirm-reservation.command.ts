import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ReservationStatus } from '../../domain/enums';
import { PharmacyInventoryErrors } from '../../domain/errors';
import {
  IReservationRepository,
  RESERVATION_REPOSITORY,
} from '../../domain/repositories/reservation.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

/**
 * Confirm flow (module-04 §8, §12) — `HELD -> CONFIRMED`, no quantity change (stock was already
 * decremented from `sellable` at reserve time). No new `stock_movements` row.
 *
 * Confirm is NOT idempotent-on-terminal-state the way release is: confirming an
 * already-`RELEASED`/`EXPIRED` reservation (e.g. it lost a race against TTL expiry) is a real
 * error, not a no-op — the caller (Module 06's payment-success handler) needs to know the
 * reservation is gone so it can compensate, not believe it silently succeeded. The status is
 * re-locked and re-read INSIDE the transaction (never trusting the pre-transaction `findById`)
 * so confirm-vs-expire cannot both "win": whichever transaction locks the row first and commits
 * establishes the terminal state; the other sees that state under its own lock and throws.
 */
@Injectable()
export class ConfirmReservationCommand {
  constructor(
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: IReservationRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: { reservationId: string; actorUserId?: string; manual?: boolean }): Promise<void> {
    const precheck = await this.reservations.findById(input.reservationId);
    if (!precheck) {
      throw PharmacyInventoryErrors.reservationNotFound();
    }

    await this.uow.run(async (tx) => {
      const reservation = await this.reservations.lockForUpdate(input.reservationId, tx);
      if (!reservation) {
        throw PharmacyInventoryErrors.reservationNotFound();
      }
      if (reservation.status === ReservationStatus.CONFIRMED) {
        return;
      }
      if (reservation.status !== ReservationStatus.HELD) {
        throw PharmacyInventoryErrors.invalidReservationState(
          reservation.status,
          ReservationStatus.CONFIRMED,
        );
      }
      if (reservation.expiresAt.getTime() <= Date.now()) {
        throw PharmacyInventoryErrors.reservationExpired();
      }

      await this.reservations.updateStatus(input.reservationId, ReservationStatus.CONFIRMED, tx);
      if (input.manual) {
        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? null,
            action: 'RESERVATION_CONFIRMED',
            resourceType: 'StockReservation',
            resourceId: input.reservationId,
          },
          tx,
        );
      }
    });
  }
}
