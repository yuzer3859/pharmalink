import { IMatchRepository, MatchRequestSnapshot } from '../../domain/repositories/match.repository';
import { GetMatchResultQuery } from './get-match-result.query';

function matchRequestSnapshot(overrides: Partial<MatchRequestSnapshot> = {}): MatchRequestSnapshot {
  return {
    id: 'match-1',
    orderId: null,
    customerUserId: 'customer-1',
    deliveryLat: null,
    deliveryLng: null,
    status: 'MATCHED',
    strategy: 'SINGLE',
    chosenResult: null,
    overridePharmacyId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build() {
  const matches: jest.Mocked<IMatchRepository> = {
    findById: jest.fn().mockResolvedValue(matchRequestSnapshot()),
    createWithCandidates: jest.fn(),
    listCandidates: jest.fn().mockResolvedValue([]),
    updateStatus: jest.fn(),
    replaceCandidates: jest.fn(),
  };
  const query = new GetMatchResultQuery(matches);
  return { query, matches };
}

describe('GetMatchResultQuery', () => {
  it('returns the match request and its candidates for the owning customer', async () => {
    const { query } = build();
    const result = await query.execute({ matchRequestId: 'match-1', customerUserId: 'customer-1' });
    expect(result.matchRequest.id).toBe('match-1');
    expect(result.candidates).toEqual([]);
  });

  it('404s (generic) when not found', async () => {
    const { query, matches } = build();
    matches.findById.mockResolvedValue(null);
    await expect(
      query.execute({ matchRequestId: 'unknown', customerUserId: 'customer-1' }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });

  it('404s (generic, no existence leak) when not owned by the caller', async () => {
    const { query, matches } = build();
    matches.findById.mockResolvedValue(matchRequestSnapshot({ customerUserId: 'someone-else' }));
    await expect(
      query.execute({ matchRequestId: 'match-1', customerUserId: 'customer-1' }),
    ).rejects.toMatchObject({ code: 'PRESCRIPTION_NOT_FOUND' });
  });
});
