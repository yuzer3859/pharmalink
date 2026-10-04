import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  LedgerTransactionDraft,
  PostedLedgerTransaction,
} from '../entities/ledger-transaction.entity';
import { LedgerAccountType, LedgerDirection, LedgerTransactionType } from '../enums';
import { ILedgerRepository } from '../repositories/ledger.repository';
import { AccountRef } from '../value-objects/account-ref.vo';
import { Money } from '../value-objects/money.vo';
import { LedgerService } from './ledger.service';

const GATEWAY_CLEARING = 'account-gateway-clearing';
const PROVIDER_PAYABLE = 'account-provider-payable';

function repositoryStub(overrides: Partial<ILedgerRepository> = {}): jest.Mocked<ILedgerRepository> {
  return {
    findAccountById: jest.fn(),
    findAccountByRef: jest.fn(),
    createAccount: jest.fn(),
    findOrCreateAccount: jest.fn(),
    createTransaction: jest.fn(),
    findTransactionById: jest.fn(),
    findTransactionByReference: jest.fn(),
    findEntriesByTransactionId: jest.fn(),
    findEntriesByAccountId: jest.fn(),
    sumEntriesByAccount: jest.fn(),
    findCachedBalance: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<ILedgerRepository>;
}

function balancedInput() {
  return {
    reference: 'CAPTURE-order-1',
    type: LedgerTransactionType.CAPTURE,
    entries: [
      { accountId: GATEWAY_CLEARING, direction: LedgerDirection.DEBIT, amount: Money.base(10_000) },
      {
        accountId: PROVIDER_PAYABLE,
        direction: LedgerDirection.CREDIT,
        amount: Money.base(10_000),
      },
    ],
  };
}

describe('LedgerService.post — the guarded entry point (§10)', () => {
  it('validates first, then persists the draft through the repository', async () => {
    const posted = { transaction: { id: 'txn-1' }, entries: [] } as unknown as PostedLedgerTransaction;
    const repo = repositoryStub({ createTransaction: jest.fn().mockResolvedValue(posted) });
    const service = new LedgerService(repo);

    await expect(service.post(balancedInput())).resolves.toBe(posted);

    expect(repo.createTransaction).toHaveBeenCalledTimes(1);
    const [draft, tx] = repo.createTransaction.mock.calls[0];
    expect(draft).toBeInstanceOf(LedgerTransactionDraft);
    expect(draft.total.amountMinor).toBe(10_000);
    expect(tx).toBeUndefined();
  });

  it('enlists in a caller-supplied transaction handle when given one', async () => {
    const repo = repositoryStub({ createTransaction: jest.fn().mockResolvedValue({}) });
    const service = new LedgerService(repo);
    const tx = { marker: 'caller-transaction' };

    await service.post(balancedInput(), tx);

    expect(repo.createTransaction.mock.calls[0][1]).toBe(tx);
  });

  it('never reaches the database when the posting does not balance', async () => {
    const repo = repositoryStub();
    const service = new LedgerService(repo);

    await expect(
      service.post({
        ...balancedInput(),
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
    ).rejects.toMatchObject({ code: ErrorCode.LEDGER_UNBALANCED });

    expect(repo.createTransaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an empty posting',
      { ...balancedInput(), entries: [] },
    ],
    [
      'a zero-amount entry',
      {
        ...balancedInput(),
        entries: [
          { accountId: GATEWAY_CLEARING, direction: LedgerDirection.DEBIT, amount: Money.base(0) },
          {
            accountId: PROVIDER_PAYABLE,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(0),
          },
        ],
      },
    ],
    [
      'a cross-currency posting',
      {
        ...balancedInput(),
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
      },
    ],
    ['a missing reference', { ...balancedInput(), reference: '' }],
  ])('rejects %s without touching the repository', async (_name, input) => {
    const repo = repositoryStub();
    const service = new LedgerService(repo);

    await expect(service.post(input)).rejects.toBeInstanceOf(ApiException);
    expect(repo.createTransaction).not.toHaveBeenCalled();
  });

  it('exposes no method that edits or deletes a posted transaction', () => {
    const methods = Object.getOwnPropertyNames(LedgerService.prototype);
    expect(methods.sort()).toEqual(
      ['balanceOf', 'balanceOfAccount', 'constructor', 'findPosting', 'post', 'resolveAccount'].sort(),
    );
  });
});

describe('LedgerService.balanceOf — derived from entries (§5.3)', () => {
  it('computes credits minus debits, in the account currency', async () => {
    const repo = repositoryStub({
      sumEntriesByAccount: jest
        .fn()
        .mockResolvedValue({ debit: 4_000, credit: 10_000, currency: 'ETB' }),
    });
    const balance = await new LedgerService(repo).balanceOf('account-1');

    expect(balance.amountMinor).toBe(6_000);
    expect(balance.currency.code).toBe('ETB');
  });

  it('returns a negative balance when debits exceed credits, and zero when they match', async () => {
    const negative = repositoryStub({
      sumEntriesByAccount: jest
        .fn()
        .mockResolvedValue({ debit: 10_000, credit: 2_500, currency: 'ETB' }),
    });
    await expect(new LedgerService(negative).balanceOf('a')).resolves.toMatchObject({
      amountMinor: -7_500,
    });

    const zero = repositoryStub({
      sumEntriesByAccount: jest.fn().mockResolvedValue({ debit: 0, credit: 0, currency: 'ETB' }),
    });
    await expect(new LedgerService(zero).balanceOf('a')).resolves.toMatchObject({ amountMinor: 0 });
  });

  it('never reads the account_balances cache to answer a balance question', async () => {
    const repo = repositoryStub({
      sumEntriesByAccount: jest
        .fn()
        .mockResolvedValue({ debit: 0, credit: 5_000, currency: 'ETB' }),
    });
    await new LedgerService(repo).balanceOf('account-1');

    expect(repo.sumEntriesByAccount).toHaveBeenCalledWith('account-1', undefined);
    expect(repo.findCachedBalance).not.toHaveBeenCalled();
  });

  it('resolveAccount / balanceOfAccount go through the natural key', async () => {
    const repo = repositoryStub({
      findOrCreateAccount: jest.fn().mockResolvedValue({ id: 'account-wallet-1' }),
      sumEntriesByAccount: jest
        .fn()
        .mockResolvedValue({ debit: 1_000, credit: 3_000, currency: 'ETB' }),
    });
    const service = new LedgerService(repo);
    const ref = AccountRef.customerWallet('user-1');

    await expect(service.resolveAccount(ref)).resolves.toEqual({ id: 'account-wallet-1' });
    expect(repo.findOrCreateAccount).toHaveBeenCalledWith(
      { type: LedgerAccountType.CUSTOMER_WALLET, ownerId: 'user-1', currency: 'ETB' },
      undefined,
    );

    await expect(service.balanceOfAccount(ref)).resolves.toMatchObject({ amountMinor: 2_000 });
  });
});

describe('LedgerService.findPosting', () => {
  it('returns a committed posting', async () => {
    const posted = { transaction: { id: 'txn-1' }, entries: [] } as unknown as PostedLedgerTransaction;
    const repo = repositoryStub({ findTransactionById: jest.fn().mockResolvedValue(posted) });

    await expect(new LedgerService(repo).findPosting('txn-1')).resolves.toBe(posted);
  });

  it('throws NOT_FOUND for an unknown posting', async () => {
    const repo = repositoryStub({ findTransactionById: jest.fn().mockResolvedValue(null) });

    await expect(new LedgerService(repo).findPosting('nope')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});
