import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { IInventoryPort } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import {
  IMatchRepository,
  MatchCandidateSnapshot,
  MatchRequestSnapshot,
} from '../../domain/repositories/match.repository';
import { IAvailabilityPort, PharmacyAvailabilityCandidate } from '../ports/outbound/availability.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { SelectMatchCommand } from './select-match.command';

function matchRequestSnapshot(overrides: Partial<MatchRequestSnapshot> = {}): MatchRequestSnapshot {
  return {
    id: 'match-1',
    orderId: null,
    customerUserId: 'customer-1',
    deliveryLat: null,
    deliveryLng: null,
    status: 'PENDING',
    strategy: 'SINGLE',
    chosenResult: null,
    overridePharmacyId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function candidateSnapshot(overrides: Partial<MatchCandidateSnapshot> = {}): MatchCandidateSnapshot {
  return {
    id: 'candidate-1',
    matchRequestId: 'match-1',
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
    coverage: 'ALL',
    totalPrice: 200,
    distanceMeters: 500,
    rating: null,
    rank: 1,
    createdAt: new Date(),
    ...overrides,
  };
}

function availabilityRow(
  overrides: Partial<PharmacyAvailabilityCandidate> = {},
): PharmacyAvailabilityCandidate {
  return {
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
    listingId: 'listing-1',
    price: 100,
    currency: 'ETB',
    sellable: 10,
    ...overrides,
  };
}

function build() {
  const matchRequest = matchRequestSnapshot();
  const matches: jest.Mocked<IMatchRepository> = {
    findById: jest.fn().mockResolvedValue(matchRequest),
    createWithCandidates: jest.fn(),
    listCandidates: jest.fn().mockResolvedValue([candidateSnapshot(), candidateSnapshot({ id: 'c2', pharmacyId: 'pharmacy-2', rank: 2 })]),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    replaceCandidates: jest.fn(),
  };
  const availability: jest.Mocked<IAvailabilityPort> = {
    getAvailability: jest.fn().mockResolvedValue([availabilityRow()]),
  };
  const inventory: jest.Mocked<IInventoryPort> = {
    reserve: jest.fn().mockResolvedValue({ reservationId: 'reservation-1', expiresAt: new Date() }),
    confirm: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    dispatch: jest.fn(),
    getReservationFulfillment: jest.fn(),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new SelectMatchCommand(matches, availability, inventory, uow, audit, outbox);
  return { command, matches, availability, inventory, audit, outbox };
}

function selectInput(overrides: Record<string, unknown> = {}) {
  return {
    matchRequestId: 'match-1',
    customerUserId: 'customer-1',
    lines: [{ catalogProductId: 'product-1', quantity: 2 }],
    ...overrides,
  };
}

describe('SelectMatchCommand', () => {
  it('reserves the rank #1 candidate before updating MatchRequest.status (ADR-014 ordering)', async () => {
    const { command, inventory, matches } = build();
    const callOrder: string[] = [];
    inventory.reserve.mockImplementation(async () => {
      callOrder.push('reserve');
      return { reservationId: 'reservation-1', expiresAt: new Date() };
    });
    matches.updateStatus.mockImplementation(async () => {
      callOrder.push('updateStatus');
    });

    const result = await command.execute(selectInput());

    expect(callOrder).toEqual(['reserve', 'updateStatus']);
    expect(result.status).toBe('PENDING'); // findById mock returns the same snapshot back
    expect(matches.updateStatus).toHaveBeenCalledWith(
      'match-1',
      expect.objectContaining({
        status: 'MATCHED',
        chosenResult: expect.objectContaining({ pharmacyId: 'pharmacy-1' }),
      }),
      undefined,
    );
  });

  it('honors an explicit customer override pharmacyId (BR-MT-03)', async () => {
    const { command, inventory, availability } = build();
    availability.getAvailability.mockResolvedValue([
      availabilityRow({ pharmacyId: 'pharmacy-2', branchId: 'branch-1', listingId: 'listing-2' }),
    ]);
    await command.execute(selectInput({ pharmacyId: 'pharmacy-2' }));
    expect(inventory.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'listing-2' }),
    );
  });

  it('throws MATCH_CANDIDATE_UNAVAILABLE for an override pharmacyId not among the candidates', async () => {
    const { command } = build();
    await expect(
      command.execute(selectInput({ pharmacyId: 'pharmacy-unknown' })),
    ).rejects.toMatchObject({ code: 'MATCH_CANDIDATE_UNAVAILABLE' });
  });

  it('throws NO_PHARMACY_MATCH when there are no candidates at all', async () => {
    const { command, matches } = build();
    matches.listCandidates.mockResolvedValue([]);
    await expect(command.execute(selectInput())).rejects.toMatchObject({ code: 'NO_PHARMACY_MATCH' });
  });

  it('404s when the match request does not exist or is not owned by the caller', async () => {
    const { command, matches } = build();
    matches.findById.mockResolvedValue(null);
    await expect(command.execute(selectInput())).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });

    matches.findById.mockResolvedValue(matchRequestSnapshot({ customerUserId: 'someone-else' }));
    await expect(command.execute(selectInput())).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });

  it('409s on an illegal match-status transition (e.g. already FAILED)', async () => {
    const { command, matches } = build();
    matches.findById.mockResolvedValue(matchRequestSnapshot({ status: 'FAILED' }));
    await expect(command.execute(selectInput())).rejects.toMatchObject({
      code: 'INVALID_MATCH_STATE_TRANSITION',
    });
  });

  it('releases already-succeeded reservations and rethrows when a later line fails to reserve (partial-reserve rollback)', async () => {
    const { command, availability, inventory } = build();
    availability.getAvailability
      .mockResolvedValueOnce([availabilityRow({ listingId: 'listing-1' })])
      .mockResolvedValueOnce([]); // second line has no availability at the chosen pharmacy
    inventory.reserve.mockResolvedValueOnce({ reservationId: 'reservation-1', expiresAt: new Date() });

    await expect(
      command.execute(
        selectInput({
          lines: [
            { catalogProductId: 'product-1', quantity: 1 },
            { catalogProductId: 'product-2', quantity: 1 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'MATCH_CANDIDATE_UNAVAILABLE' });

    expect(inventory.release).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'reservation-1' }),
    );
  });

  it('writes an audit entry and an OrderMatched event', async () => {
    const { command, audit, outbox } = build();
    await command.execute(selectInput());
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MATCH_SELECTED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });
});
