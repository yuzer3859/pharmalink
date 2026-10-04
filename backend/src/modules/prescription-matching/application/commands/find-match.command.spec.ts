import { AuditService } from '../../../../shared/audit/audit.service';
import { IConfigPort } from '../../../../shared/config/config.port';
import {
  IMatchRepository,
  MatchCandidateSnapshot,
  MatchRequestSnapshot,
} from '../../domain/repositories/match.repository';
import { IAvailabilityPort, PharmacyAvailabilityCandidate } from '../ports/outbound/availability.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { FindMatchCommand } from './find-match.command';

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

function candidate(overrides: Partial<PharmacyAvailabilityCandidate> = {}): PharmacyAvailabilityCandidate {
  return {
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
    listingId: 'listing-1',
    price: 100,
    currency: 'ETB',
    sellable: 10,
    distanceMeters: 500,
    ...overrides,
  };
}

function build() {
  const matches: jest.Mocked<IMatchRepository> = {
    findById: jest.fn(),
    createWithCandidates: jest.fn().mockImplementation(async (data, candidates) => ({
      matchRequest: matchRequestSnapshot({ customerUserId: data.customerUserId }),
      candidates: candidates.map(
        (c: unknown, i: number): MatchCandidateSnapshot => ({
          id: `candidate-${i}`,
          matchRequestId: 'match-1',
          createdAt: new Date(),
          ...(c as object),
        }) as MatchCandidateSnapshot,
      ),
    })),
    listCandidates: jest.fn(),
    updateStatus: jest.fn(),
    replaceCandidates: jest.fn(),
  };
  const availability: jest.Mocked<IAvailabilityPort> = {
    getAvailability: jest.fn().mockResolvedValue([candidate()]),
  };
  const config: jest.Mocked<IConfigPort> = {
    get: jest.fn().mockReturnValue(undefined),
    getOrThrow: jest.fn(),
    isFeatureEnabled: jest.fn(),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;

  const command = new FindMatchCommand(matches, availability, config, uow, audit);
  return { command, matches, availability, config, audit };
}

describe('FindMatchCommand', () => {
  it('ranks and persists full-coverage candidates', async () => {
    const { command, matches, audit } = build();
    const result = await command.execute({
      customerUserId: 'customer-1',
      lines: [{ catalogProductId: 'product-1', quantity: 2 }],
    });

    expect(result.candidates).toHaveLength(1);
    expect(matches.createWithCandidates).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MATCH_REQUEST_CREATED' }),
      undefined,
    );
  });

  it('excludes a pharmacy that cannot cover every requested line (no split fulfillment, §0.2/§5.5)', async () => {
    const { command, availability } = build();
    availability.getAvailability
      .mockResolvedValueOnce([candidate({ pharmacyId: 'pharmacy-1', branchId: 'branch-1' })])
      .mockResolvedValueOnce([candidate({ pharmacyId: 'pharmacy-2', branchId: 'branch-2' })]); // different pharmacy for line 2

    await expect(
      command.execute({
        customerUserId: 'customer-1',
        lines: [
          { catalogProductId: 'product-1', quantity: 1 },
          { catalogProductId: 'product-2', quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NO_PHARMACY_MATCH' });
  });

  it('excludes a pharmacy with insufficient sellable stock for a line', async () => {
    const { command, availability } = build();
    availability.getAvailability.mockResolvedValue([candidate({ sellable: 1 })]);
    await expect(
      command.execute({
        customerUserId: 'customer-1',
        lines: [{ catalogProductId: 'product-1', quantity: 5 }],
      }),
    ).rejects.toMatchObject({ code: 'NO_PHARMACY_MATCH' });
  });

  it('throws NO_PHARMACY_MATCH when availability is empty', async () => {
    const { command, availability } = build();
    availability.getAvailability.mockResolvedValue([]);
    await expect(
      command.execute({ customerUserId: 'customer-1', lines: [{ catalogProductId: 'product-1', quantity: 1 }] }),
    ).rejects.toMatchObject({ code: 'NO_PHARMACY_MATCH' });
  });

  it('validates that at least one line is provided', async () => {
    const { command } = build();
    await expect(
      command.execute({ customerUserId: 'customer-1', lines: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('ranks a closer, pricier pharmacy ahead of a farther, cheaper one under distance-dominant default weights', async () => {
    const { command, availability } = build();
    const near = candidate({ pharmacyId: 'pharmacy-near', branchId: 'b1', distanceMeters: 100, price: 200 });
    const far = candidate({ pharmacyId: 'pharmacy-far', branchId: 'b2', distanceMeters: 5000, price: 50 });
    availability.getAvailability.mockResolvedValue([near, far]);

    const result = await command.execute({
      customerUserId: 'customer-1',
      lines: [{ catalogProductId: 'product-1', quantity: 1 }],
    });
    const ranks = result.candidates.map((c) => ({ pharmacyId: c.pharmacyId, rank: c.rank }));
    const nearRank = ranks.find((r) => r.pharmacyId === 'pharmacy-near')?.rank;
    const farRank = ranks.find((r) => r.pharmacyId === 'pharmacy-far')?.rank;
    expect(nearRank).toBeLessThan(farRank as number);
  });
});
