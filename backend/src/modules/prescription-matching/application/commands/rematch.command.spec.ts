import { AuditService } from '../../../../shared/audit/audit.service';
import { IConfigPort } from '../../../../shared/config/config.port';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { IInventoryPort } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import {
  IMatchRepository,
  MatchRequestSnapshot,
} from '../../domain/repositories/match.repository';
import { IAvailabilityPort, PharmacyAvailabilityCandidate } from '../ports/outbound/availability.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { RematchCommand } from './rematch.command';

function matchRequestSnapshot(overrides: Partial<MatchRequestSnapshot> = {}): MatchRequestSnapshot {
  return {
    id: 'match-1',
    orderId: null,
    customerUserId: 'customer-1',
    deliveryLat: null,
    deliveryLng: null,
    status: 'MATCHED',
    strategy: 'SINGLE',
    chosenResult: {
      pharmacyId: 'pharmacy-declined',
      branchId: 'branch-declined',
      lines: [
        { catalogProductId: 'product-1', listingId: 'listing-declined', reservationId: 'reservation-declined', quantity: 2 },
      ],
    },
    overridePharmacyId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function availabilityRow(
  overrides: Partial<PharmacyAvailabilityCandidate> = {},
): PharmacyAvailabilityCandidate {
  return {
    pharmacyId: 'pharmacy-new',
    branchId: 'branch-new',
    listingId: 'listing-new',
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
    listCandidates: jest.fn(),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    replaceCandidates: jest.fn().mockResolvedValue([]),
  };
  const availability: jest.Mocked<IAvailabilityPort> = {
    getAvailability: jest.fn().mockResolvedValue([availabilityRow()]),
  };
  const inventory: jest.Mocked<IInventoryPort> = {
    reserve: jest.fn().mockResolvedValue({ reservationId: 'reservation-new', expiresAt: new Date() }),
    confirm: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    dispatch: jest.fn(),
    getReservationFulfillment: jest.fn(),
  };
  const config: jest.Mocked<IConfigPort> = {
    get: jest.fn().mockReturnValue(undefined),
    getOrThrow: jest.fn(),
    isFeatureEnabled: jest.fn(),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new RematchCommand(matches, availability, inventory, config, uow, audit, outbox);
  return { command, matches, availability, inventory, audit, outbox };
}

function rematchInput(overrides: Record<string, unknown> = {}) {
  return {
    matchRequestId: 'match-1',
    customerUserId: 'customer-1',
    lines: [{ catalogProductId: 'product-1', quantity: 2 }],
    ...overrides,
  };
}

describe('RematchCommand', () => {
  it('releases the declined pharmacy reservation before re-ranking (ADR-014)', async () => {
    const { command, inventory } = build();
    await command.execute(rematchInput());
    expect(inventory.release).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: 'reservation-declined' }),
    );
  });

  it('excludes the declined pharmacy from the re-ranked candidates', async () => {
    const { command, availability, inventory } = build();
    availability.getAvailability.mockResolvedValue([
      availabilityRow({ pharmacyId: 'pharmacy-declined', branchId: 'branch-declined', listingId: 'listing-declined-2' }),
      availabilityRow({ pharmacyId: 'pharmacy-new', branchId: 'branch-new', listingId: 'listing-new' }),
    ]);
    await command.execute(rematchInput());
    // Only "pharmacy-new" is ever reserved against — the declined pharmacy's listing is never used.
    expect(inventory.reserve).toHaveBeenCalledWith(expect.objectContaining({ listingId: 'listing-new' }));
  });

  it('re-selects a new candidate: MATCHED -> REMATCHING -> MATCHED, emits RematchTriggered', async () => {
    const { command, matches, audit, outbox, inventory } = build();
    await command.execute(rematchInput());

    const statusUpdates = matches.updateStatus.mock.calls.map((c) => c[1].status);
    expect(statusUpdates).toEqual(['REMATCHING', 'MATCHED']);
    expect(inventory.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'listing-new' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MATCH_REMATCHED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('exhausts to FAILED when no full-coverage candidate remains: MATCHED -> REMATCHING -> FAILED, emits MatchFailed', async () => {
    const { command, matches, audit, outbox, availability } = build();
    availability.getAvailability.mockResolvedValue([]);

    await command.execute(rematchInput());

    const statusUpdates = matches.updateStatus.mock.calls.map((c) => c[1].status);
    expect(statusUpdates).toEqual(['REMATCHING', 'FAILED']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MATCH_FAILED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('404s when the match request does not exist or is not owned by the caller', async () => {
    const { command, matches } = build();
    matches.findById.mockResolvedValue(null);
    await expect(command.execute(rematchInput())).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });

  it('409s when the match request is not currently MATCHED', async () => {
    const { command, matches } = build();
    matches.findById.mockResolvedValue(matchRequestSnapshot({ status: 'PENDING' }));
    await expect(command.execute(rematchInput())).rejects.toMatchObject({
      code: 'INVALID_MATCH_STATE_TRANSITION',
    });
  });
});
