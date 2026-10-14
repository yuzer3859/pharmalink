import { ConfirmReservationCommand } from './confirm-reservation.command';
import { InventoryListing } from '../../domain/entities/inventory-listing.entity';
import { ReservationStatus, StorageRequirement } from '../../domain/enums';

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
  let listings: { lockForUpdate: jest.Mock; updateCache: jest.Mock };
  let ledger: { findBatchesByListing: jest.Mock; recordMovement: jest.Mock };
  let outbox: { write: jest.Mock };
  let command: ConfirmReservationCommand;

  function buildListing(onHand = 10, reserved = 4): InventoryListing {
    const listing = InventoryListing.create('listing-1', {
      pharmacyId: 'pharmacy-1',
      branchId: 'branch-1',
      catalogProductId: 'product-1',
      price: 100,
      currency: 'ETB',
      storageRequirement: StorageRequirement.AMBIENT,
    });
    return InventoryListing.rehydrate({ ...listing.toProps(), onHand, reserved, sellable: onHand - reserved });
  }

  beforeEach(() => {
    reservations = {
      findById: jest.fn().mockResolvedValue(held),
      lockForUpdate: jest.fn().mockResolvedValue(held),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };
    uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    listings = {
      lockForUpdate: jest.fn().mockResolvedValue(buildListing()),
      updateCache: jest.fn().mockResolvedValue(undefined),
    };
    ledger = {
      findBatchesByListing: jest.fn().mockResolvedValue([
        { id: 'batch-1', quantity: 10, expiryDate: new Date('2030-01-01') },
      ]),
      recordMovement: jest.fn().mockResolvedValue(undefined),
    };
    outbox = { write: jest.fn().mockResolvedValue(undefined) };
    command = new ConfirmReservationCommand(
      reservations as never,
      listings as never,
      ledger as never,
      uow as never,
      audit as never,
      outbox as never,
    );
  });

  it('confirms a HELD reservation', async () => {
    await command.execute({ reservationId });
    expect(reservations.updateStatus).toHaveBeenCalledWith(
      reservationId,
      ReservationStatus.CONFIRMED,
      {},
    );
    // A valid confirm changes no quantity: no listing lock, movement, cache or outbox write.
    expect(listings.lockForUpdate).not.toHaveBeenCalled();
    expect(ledger.recordMovement).not.toHaveBeenCalled();
    expect(listings.updateCache).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
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

  it('Work 53: a lapsed hold found under the lock is expired in the same transaction — the ' +
    "sweeper's exact effect — and RESERVATION_EXPIRED is raised only after it commits", async () => {
    const stale = { ...held, expiresAt: new Date(Date.now() - 1000) };
    reservations.findById.mockResolvedValue(stale);
    reservations.lockForUpdate.mockResolvedValue(stale);
    let committed = false;
    uow.run.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const result = await work({});
      committed = true;
      return result;
    });

    await expect(command.execute({ reservationId })).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });

    expect(committed).toBe(true);
    expect(reservations.updateStatus).toHaveBeenCalledTimes(1);
    expect(reservations.updateStatus).toHaveBeenCalledWith(reservationId, ReservationStatus.EXPIRED, {});
    expect(ledger.recordMovement).toHaveBeenCalledTimes(1);
    expect(ledger.recordMovement).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RELEASE', quantityDelta: 4, reservationId, refType: 'SYSTEM', reason: 'TTL expiry' }),
      {},
    );
    expect(listings.updateCache).toHaveBeenCalledWith('listing-1', { reserved: 0, sellable: 10 }, {});
    expect(outbox.write).toHaveBeenCalledTimes(1);
    expect(outbox.write.mock.calls[0][0]).toMatchObject({ payload: { reservationId, quantity: 4, reason: 'TTL_EXPIRED' } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('Work 53: at exactly expiresAt == now confirm still rejects (its <=) but expires nothing — ' +
    "the sweeper's strict < boundary is unchanged and it takes the row on a later tick", async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const boundary = { ...held, expiresAt: new Date(now) };
      reservations.findById.mockResolvedValue(boundary);
      reservations.lockForUpdate.mockResolvedValue(boundary);

      await expect(command.execute({ reservationId })).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });

      expect(reservations.updateStatus).not.toHaveBeenCalled();
      expect(listings.lockForUpdate).not.toHaveBeenCalled();
      expect(ledger.recordMovement).not.toHaveBeenCalled();
      expect(outbox.write).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('Work 53: if the expiry itself fails an invariant, nothing is written (rolled back, left HELD ' +
    'for the sweeper) and the caller still gets RESERVATION_EXPIRED, never a confirm', async () => {
    const stale = { ...held, expiresAt: new Date(Date.now() - 1000) };
    reservations.findById.mockResolvedValue(stale);
    reservations.lockForUpdate.mockResolvedValue(stale);
    listings.lockForUpdate.mockResolvedValue(buildListing(10, 0)); // reserved would go negative

    await expect(command.execute({ reservationId })).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });

    expect(reservations.updateStatus).not.toHaveBeenCalled();
    expect(ledger.recordMovement).not.toHaveBeenCalled();
    expect(listings.updateCache).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('Work 53: RELEASED and EXPIRED rows are not transitioned and no expiry effect is applied', async () => {
    for (const status of [ReservationStatus.RELEASED, ReservationStatus.EXPIRED]) {
      const terminal = { ...held, status, expiresAt: new Date(Date.now() - 1000) };
      reservations.lockForUpdate.mockResolvedValue(terminal);
      await expect(command.execute({ reservationId })).rejects.toMatchObject({ code: 'INVALID_RESERVATION_STATE' });
    }
    expect(reservations.updateStatus).not.toHaveBeenCalled();
    expect(listings.lockForUpdate).not.toHaveBeenCalled();
    expect(ledger.recordMovement).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('Work 53: a CONFIRMED row past its expiresAt stays CONFIRMED — confirm never expires it', async () => {
    const confirmed = { ...held, status: ReservationStatus.CONFIRMED, expiresAt: new Date(Date.now() - 1000) };
    reservations.lockForUpdate.mockResolvedValue(confirmed);

    await command.execute({ reservationId });

    expect(reservations.updateStatus).not.toHaveBeenCalled();
    expect(ledger.recordMovement).not.toHaveBeenCalled();
  });
});
