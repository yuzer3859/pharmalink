import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { LedgerDirection, LedgerTransactionType } from '../enums';
import { MAX_PERSISTABLE_MINOR_UNITS, Money } from '../value-objects/money.vo';
import {
  LedgerEntryDraftInput,
  LedgerTransactionDraft,
  NewLedgerTransactionInput,
} from './ledger-transaction.entity';

const GATEWAY_CLEARING = 'account-gateway-clearing';
const PROVIDER_PAYABLE = 'account-provider-payable';
const PLATFORM_REVENUE = 'account-platform-revenue';

function expectApiError(fn: () => unknown, code: ErrorCode): void {
  expect(fn).toThrow(ApiException);
  try {
    fn();
  } catch (error) {
    expect((error as ApiException).code).toBe(code);
  }
}

function draft(overrides: Partial<NewLedgerTransactionInput> = {}): NewLedgerTransactionInput {
  return {
    reference: 'CAPTURE-order-1',
    type: LedgerTransactionType.CAPTURE,
    refType: 'payment',
    refId: 'payment-1',
    description: 'Capture for order-1',
    entries: [
      { accountId: GATEWAY_CLEARING, direction: LedgerDirection.DEBIT, amount: Money.base(10_000) },
      {
        accountId: PROVIDER_PAYABLE,
        direction: LedgerDirection.CREDIT,
        amount: Money.base(10_000),
      },
    ],
    ...overrides,
  };
}

describe('LedgerTransactionDraft — balanced postings are accepted', () => {
  it('accepts a simple two-sided posting and exposes its total', () => {
    const posting = LedgerTransactionDraft.create(draft());

    expect(posting.reference).toBe('CAPTURE-order-1');
    expect(posting.type).toBe(LedgerTransactionType.CAPTURE);
    expect(posting.refType).toBe('payment');
    expect(posting.refId).toBe('payment-1');
    expect(posting.entries).toHaveLength(2);
    expect(posting.currency.code).toBe('ETB');
    expect(posting.total.amountMinor).toBe(10_000);
  });

  it("accepts the design's own capture example: 100 ETB, 10% platform fee (§7)", () => {
    const posting = LedgerTransactionDraft.create(
      draft({
        entries: [
          {
            accountId: GATEWAY_CLEARING,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(10_000),
          },
          {
            accountId: PROVIDER_PAYABLE,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(9_000),
          },
          {
            accountId: PLATFORM_REVENUE,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(1_000),
          },
        ],
      }),
    );

    const debits = posting.entries.filter((e) => e.direction === LedgerDirection.DEBIT);
    const credits = posting.entries.filter((e) => e.direction === LedgerDirection.CREDIT);
    const sum = (entries: typeof posting.entries): number =>
      entries.reduce((total, entry) => total + entry.amount.amountMinor, 0);

    expect(sum(debits)).toBe(10_000);
    expect(sum(credits)).toBe(10_000);
    expect(sum(debits)).toBe(sum(credits));
    expect(posting.affectedAccountIds()).toEqual([
      GATEWAY_CLEARING,
      PROVIDER_PAYABLE,
      PLATFORM_REVENUE,
    ]);
  });

  it('accepts many-to-many postings and de-duplicates the affected account list', () => {
    const posting = LedgerTransactionDraft.create(
      draft({
        entries: [
          {
            accountId: GATEWAY_CLEARING,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(6_000),
          },
          {
            accountId: GATEWAY_CLEARING,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(4_000),
          },
          {
            accountId: PROVIDER_PAYABLE,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(10_000),
          },
        ],
      }),
    );
    expect(posting.affectedAccountIds()).toEqual([GATEWAY_CLEARING, PROVIDER_PAYABLE]);
  });

  it('normalises optional text and trims the reference', () => {
    const posting = LedgerTransactionDraft.create(
      draft({ reference: '  REF-1234  ', refType: '  ', refId: null, description: undefined }),
    );
    expect(posting.reference).toBe('REF-1234');
    expect(posting.refType).toBeNull();
    expect(posting.refId).toBeNull();
    expect(posting.description).toBeNull();
  });
});

describe('LedgerTransactionDraft — unbalanced postings are rejected (§5.3, §12)', () => {
  it('rejects debits != credits with LEDGER_UNBALANCED and reports both totals', () => {
    const act = () =>
      LedgerTransactionDraft.create(
        draft({
          entries: [
            {
              accountId: GATEWAY_CLEARING,
              direction: LedgerDirection.DEBIT,
              amount: Money.base(10_000),
            },
            {
              accountId: PROVIDER_PAYABLE,
              direction: LedgerDirection.CREDIT,
              amount: Money.base(9_000),
            },
          ],
        }),
      );

    expectApiError(act, ErrorCode.LEDGER_UNBALANCED);
    try {
      act();
    } catch (error) {
      expect((error as ApiException).details).toEqual({
        debit: 10_000,
        credit: 9_000,
        currency: 'ETB',
      });
    }
  });

  it('rejects a posting that is off by a single minor unit', () => {
    expectApiError(
      () =>
        LedgerTransactionDraft.create(
          draft({
            entries: [
              {
                accountId: GATEWAY_CLEARING,
                direction: LedgerDirection.DEBIT,
                amount: Money.base(10_000),
              },
              {
                accountId: PROVIDER_PAYABLE,
                direction: LedgerDirection.CREDIT,
                amount: Money.base(9_999),
              },
            ],
          }),
        ),
      ErrorCode.LEDGER_UNBALANCED,
    );
  });

  it('rejects a fee split that does not add up (the classic capture bug)', () => {
    expectApiError(
      () =>
        LedgerTransactionDraft.create(
          draft({
            entries: [
              {
                accountId: GATEWAY_CLEARING,
                direction: LedgerDirection.DEBIT,
                amount: Money.base(10_000),
              },
              {
                accountId: PROVIDER_PAYABLE,
                direction: LedgerDirection.CREDIT,
                amount: Money.base(9_000),
              },
              {
                accountId: PLATFORM_REVENUE,
                direction: LedgerDirection.CREDIT,
                amount: Money.base(1_100),
              },
            ],
          }),
        ),
      ErrorCode.LEDGER_UNBALANCED,
    );
  });
});

describe('LedgerTransactionDraft — structural rejections', () => {
  it('rejects an empty transaction', () => {
    expectApiError(
      () => LedgerTransactionDraft.create(draft({ entries: [] })),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a one-sided transaction (debits only, or credits only)', () => {
    for (const direction of [LedgerDirection.DEBIT, LedgerDirection.CREDIT]) {
      expectApiError(
        () =>
          LedgerTransactionDraft.create(
            draft({
              entries: [
                { accountId: GATEWAY_CLEARING, direction, amount: Money.base(5_000) },
                { accountId: PROVIDER_PAYABLE, direction, amount: Money.base(5_000) },
              ],
            }),
          ),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  });

  it.each([0, -1, -10_000])('rejects the entry amount %p', (amount) => {
    expectApiError(
      () =>
        LedgerTransactionDraft.create(
          draft({
            entries: [
              {
                accountId: GATEWAY_CLEARING,
                direction: LedgerDirection.DEBIT,
                amount: Money.base(amount),
              },
              {
                accountId: PROVIDER_PAYABLE,
                direction: LedgerDirection.CREDIT,
                amount: Money.base(amount),
              },
            ],
          }),
        ),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects an amount that would overflow the Int money column', () => {
    expectApiError(
      () =>
        LedgerTransactionDraft.create(
          draft({
            entries: [
              {
                accountId: GATEWAY_CLEARING,
                direction: LedgerDirection.DEBIT,
                amount: Money.base(MAX_PERSISTABLE_MINOR_UNITS + 1),
              },
              {
                accountId: PROVIDER_PAYABLE,
                direction: LedgerDirection.CREDIT,
                amount: Money.base(MAX_PERSISTABLE_MINOR_UNITS + 1),
              },
            ],
          }),
        ),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it.each([
    ['a missing account', { accountId: '', direction: LedgerDirection.CREDIT }],
    ['a blank account', { accountId: '   ', direction: LedgerDirection.CREDIT }],
    ['a missing direction', { accountId: PROVIDER_PAYABLE, direction: undefined }],
    ['an unknown direction', { accountId: PROVIDER_PAYABLE, direction: 'SIDEWAYS' }],
  ])('rejects an entry with %s', (_name, partial) => {
    expectApiError(
      () =>
        LedgerTransactionDraft.create(
          draft({
            entries: [
              {
                accountId: GATEWAY_CLEARING,
                direction: LedgerDirection.DEBIT,
                amount: Money.base(10_000),
              },
              {
                ...(partial as unknown as LedgerEntryDraftInput),
                amount: Money.base(10_000),
              },
            ],
          }),
        ),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects an entry with a missing or non-Money amount', () => {
    for (const amount of [undefined, null, 10_000]) {
      expectApiError(
        () =>
          LedgerTransactionDraft.create(
            draft({
              entries: [
                {
                  accountId: GATEWAY_CLEARING,
                  direction: LedgerDirection.DEBIT,
                  amount: Money.base(10_000),
                },
                {
                  accountId: PROVIDER_PAYABLE,
                  direction: LedgerDirection.CREDIT,
                  amount: amount as unknown as Money,
                },
              ],
            }),
          ),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  });

  it('rejects a transaction mixing currencies — converting is an explicit FX posting (§8)', () => {
    expectApiError(
      () =>
        LedgerTransactionDraft.create(
          draft({
            entries: [
              {
                accountId: GATEWAY_CLEARING,
                direction: LedgerDirection.DEBIT,
                amount: Money.of(10_000, 'ETB'),
              },
              {
                accountId: PROVIDER_PAYABLE,
                direction: LedgerDirection.CREDIT,
                amount: Money.of(10_000, 'USD'),
              },
            ],
          }),
        ),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('accepts a wholly non-ETB posting, as long as it is internally consistent', () => {
    const posting = LedgerTransactionDraft.create(
      draft({
        type: LedgerTransactionType.FX,
        entries: [
          {
            accountId: GATEWAY_CLEARING,
            direction: LedgerDirection.DEBIT,
            amount: Money.of(1_000, 'USD'),
          },
          {
            accountId: PROVIDER_PAYABLE,
            direction: LedgerDirection.CREDIT,
            amount: Money.of(1_000, 'USD'),
          },
        ],
      }),
    );
    expect(posting.currency.code).toBe('USD');
  });

  it.each(['', '   ', 'x'.repeat(129)])('rejects the reference %p (BRULE-25)', (reference) => {
    expectApiError(
      () => LedgerTransactionDraft.create(draft({ reference })),
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects an unknown transaction type and over-long metadata', () => {
    expectApiError(
      () =>
        LedgerTransactionDraft.create(
          draft({ type: 'TELEPORT' as LedgerTransactionType }),
        ),
      ErrorCode.VALIDATION_ERROR,
    );
    expectApiError(
      () => LedgerTransactionDraft.create(draft({ refType: 'x'.repeat(65) })),
      ErrorCode.VALIDATION_ERROR,
    );
    expectApiError(
      () => LedgerTransactionDraft.create(draft({ description: 'x'.repeat(513) })),
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

describe('LedgerTransactionDraft — immutability', () => {
  it('exposes no mutator for a validated posting', () => {
    const posting = LedgerTransactionDraft.create(draft());
    const mutable = posting as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(posting));

    expect(methods).toEqual(expect.arrayContaining(['constructor', 'affectedAccountIds']));
    for (const method of methods) {
      expect(method).not.toMatch(/^(update|set|delete|remove|mutate|edit)/i);
    }
    expect(typeof mutable.affectedAccountIds).toBe('function');
  });

  it('does not adopt the caller’s entry array — later mutation cannot change the posting', () => {
    const input = draft();
    const posting = LedgerTransactionDraft.create(input);
    input.entries.push({
      accountId: PLATFORM_REVENUE,
      direction: LedgerDirection.CREDIT,
      amount: Money.base(50_000),
    });
    expect(posting.entries).toHaveLength(2);
    expect(posting.total.amountMinor).toBe(10_000);
  });
});
