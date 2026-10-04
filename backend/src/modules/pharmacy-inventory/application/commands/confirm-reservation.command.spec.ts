import { ConfirmReservationCommand } from './confirm-reservation.command';
import { ReservationStatus } from '../../domain/enums';

describe('ConfirmReservationCommand', () => {
  const reservationId = 'reservation-1';
  const held = {
    id: reservationId,
    listingId: 'listing-1',
    orderId: 'order-1',
    quantity: 4,
    status: ReservationStatus.HELD,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  };

  let reservations: { findById: jest.Mock; lockForUpdate: jest.Mock; updateStatus: jest.Mock };
  let uow: { run: jest.Mock };
  let audit: { record: jest.Mock };
  let command: ConfirmReservationCommand;

  beforeEach(() => {
    reservations = {
      findById: jest.fn().mockResolvedValue(held),
      lockForUpdate: jest.fn().mockResolvedValue(held),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    command = new ConfirmReservationCommand(reservations as never, uow as never, audit as never);
  });

  it('confirms a HELD reservation', async () => {
    await command.execute({ reservationId });
    expect(reservations.updateStatus).toHaveBeenCalledWith(
      reservationId,
      ReservationStatus.CONFIRMED,
      {},
    );
  });

  it('is idempotent for an already-CONFIRMED reservation (no-op)', async () => {
    const confirmed = { ...held, status: ReservationStatus.CONFIRMED };
    reservations.findById.mockResolvedValue(confirmed);
    reservations.lockForUpdate.mockResolvedValue(confirmed);

    await command.execute({ reservationId });

    expect(reservations.updateStatus).not.toHaveBeenCalled();
  });

  it('confirm-vs-expire race: if the row is EXPIRED under the lock (even though the ' +
    'pre-transaction pre-check saw HELD), it throws a deterministic invalid-state error rather ' +
    'than confirming a reservation that no longer exists as an active hold', async () => {
    reservations.findById.mockResolvedValue(held); // stale pre-check
    reservations.lockForUpdate.mockResolvedValue({ ...held, status: ReservationStatus.EXPIRED });

    await expect(command.execute({ reservationId })).rejects.toMatchObject({
      code: 'INVALID_RESERVATION_STATE',
    });
    expect(reservations.updateStatus).not.toHaveBeenCalled();
  });

  it('rejects confirming an already-expired-by-TTL HELD row past its expiresAt', async () => {
    const stale = { ...held, expiresAt: new Date(Date.now() - 1000) };
    reservations.findById.mockResolvedValue(stale);
    reservations.lockForUpdate.mockResolvedValue(stale);

    await expect(command.execute({ reservationId })).rejects.toMatchObject({
      code: 'RESERVATION_EXPIRED',
    });
  });
});
