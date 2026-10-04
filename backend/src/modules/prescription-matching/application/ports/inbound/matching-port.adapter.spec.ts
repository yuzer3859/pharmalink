import { FindMatchCommand, FindMatchResult } from '../../commands/find-match.command';
import { RematchCommand } from '../../commands/rematch.command';
import { SelectMatchCommand } from '../../commands/select-match.command';
import { MatchRequestSnapshot } from '../../../domain/repositories/match.repository';
import { MatchingPortAdapter } from './matching-port.adapter';

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

/**
 * `MatchingPortAdapter` — the module-05 side of the module-06 `IMatchingPort` boundary
 * (`06-orders-spec.md` §13.1 Option B). Every existing command (`FindMatchCommand`/
 * `SelectMatchCommand`/`RematchCommand`) already has its own full test suite covering ranking,
 * reservation, ADR-014 ordering, and retry — this spec asserts *only* the facade's own
 * responsibility: delegating each port method to the correct command's `execute()` with the
 * input passed through unchanged, and returning that command's result unchanged.
 */
describe('MatchingPortAdapter', () => {
  function build() {
    const findMatchCommand = { execute: jest.fn() } as unknown as jest.Mocked<FindMatchCommand>;
    const selectMatchCommand = { execute: jest.fn() } as unknown as jest.Mocked<SelectMatchCommand>;
    const rematchCommand = { execute: jest.fn() } as unknown as jest.Mocked<RematchCommand>;
    const adapter = new MatchingPortAdapter(findMatchCommand, selectMatchCommand, rematchCommand);
    return { adapter, findMatchCommand, selectMatchCommand, rematchCommand };
  }

  it('find() delegates to FindMatchCommand.execute() with the input unchanged and returns its result unchanged', async () => {
    const { adapter, findMatchCommand } = build();
    const input = {
      customerUserId: 'customer-1',
      lines: [{ catalogProductId: 'product-1', quantity: 2 }],
    };
    const result: FindMatchResult = {
      matchRequest: matchRequestSnapshot(),
      candidates: [],
    };
    findMatchCommand.execute.mockResolvedValue(result);

    const actual = await adapter.find(input);

    expect(findMatchCommand.execute).toHaveBeenCalledTimes(1);
    expect(findMatchCommand.execute).toHaveBeenCalledWith(input);
    expect(actual).toBe(result);
  });

  it('select() delegates to SelectMatchCommand.execute() with the input unchanged and returns its result unchanged', async () => {
    const { adapter, selectMatchCommand } = build();
    const input = {
      matchRequestId: 'match-1',
      customerUserId: 'customer-1',
      pharmacyId: 'pharmacy-1',
      lines: [{ catalogProductId: 'product-1', quantity: 2 }],
    };
    const result = matchRequestSnapshot({ status: 'MATCHED' });
    selectMatchCommand.execute.mockResolvedValue(result);

    const actual = await adapter.select(input);

    expect(selectMatchCommand.execute).toHaveBeenCalledTimes(1);
    expect(selectMatchCommand.execute).toHaveBeenCalledWith(input);
    expect(actual).toBe(result);
  });

  it('rematch() delegates to RematchCommand.execute() with the input unchanged and returns its result unchanged', async () => {
    const { adapter, rematchCommand } = build();
    const input = {
      matchRequestId: 'match-1',
      customerUserId: 'customer-1',
      lines: [{ catalogProductId: 'product-1', quantity: 2 }],
    };
    const result = matchRequestSnapshot({ status: 'FAILED' });
    rematchCommand.execute.mockResolvedValue(result);

    const actual = await adapter.rematch(input);

    expect(rematchCommand.execute).toHaveBeenCalledTimes(1);
    expect(rematchCommand.execute).toHaveBeenCalledWith(input);
    expect(actual).toBe(result);
  });

  it('propagates a rejection from the delegated command unchanged (no error translation/swallowing)', async () => {
    const { adapter, findMatchCommand } = build();
    const error = new Error('NO_PHARMACY_MATCH');
    findMatchCommand.execute.mockRejectedValue(error);

    await expect(
      adapter.find({ customerUserId: 'customer-1', lines: [{ catalogProductId: 'product-1', quantity: 1 }] }),
    ).rejects.toBe(error);
  });
});
