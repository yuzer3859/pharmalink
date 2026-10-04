import { Prisma } from '@prisma/client';
import {
  LedgerTransactionDraft,
  NewLedgerTransactionInput,
} from '../../src/modules/payment/domain/entities/ledger-transaction.entity';
import {
  LedgerAccountType,
  LedgerDirection,
  LedgerTransactionType,
} from '../../src/modules/payment/domain/enums';
import { LedgerService } from '../../src/modules/payment/domain/services/ledger.service';
import { AccountRef } from '../../src/modules/payment/domain/value-objects/account-ref.vo';
import { Money } from '../../src/modules/payment/domain/value-objects/money.vo';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { PrismaLedgerRepository } from '../../src/modules/payment/infrastructure/persistence/prisma-ledger.repository';
import { PrismaUnitOfWork } from '../../src/modules/payment/infrastructure/persistence/prisma-unit-of-work';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { createPrisma, resetPaymentTables, uniqueRef } from './support';

/**
 * Ledger invariants that only a real PostgreSQL can prove: atomicity of a posting, uniqueness of
 * a transaction reference, the append-only triggers, and a balance derived by aggregating actual
 * rows. None of these are mocked — a mocked database would prove nothing about the guarantees
 * this module's money-safety rests on.
 */
describe('PrismaLedgerRepository + LedgerService (e2e)', () => {
  let prisma: PrismaService;
  let repo: PrismaLedgerRepository;
  let ledger: LedgerService;
  let uow: PrismaUnitOfWork;

  beforeAll(async () => {
    prisma = await createPrisma();
    repo = new PrismaLedgerRepository(prisma);
    ledger = new LedgerService(repo);
    uow = new PrismaUnitOfWork(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetPaymentTables(prisma);
  });

  /** Opens the three accounts the design's capture example uses (§7). */
  async function openCaptureAccounts(pharmacyId = 'pharmacy-1'): Promise<{
    gateway: string;
    payable: string;
    revenue: string;
  }> {
    const gateway = await ledger.resolveAccount(
      AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING),
    );
    const payable = await ledger.resolveAccount(AccountRef.providerPayable(pharmacyId));
    const revenue = await ledger.resolveAccount(
      AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE),
    );
    return { gateway: gateway.id, payable: payable.id, revenue: revenue.id };
  }

  describe('chart of accounts', () => {
    it('creates an account and resolves it by its natural key (type, ownerId, currency)', async () => {
      const created = await repo.createAccount({
        type: LedgerAccountType.CUSTOMER_WALLET,
        ownerId: 'user-1',
        currency: 'ETB',
      });

      expect(created.id).toEqual(expect.any(String));
      expect(created.type).toBe(LedgerAccountType.CUSTOMER_WALLET);
      expect(created.ownerId).toBe('user-1');
      expect(created.currency).toBe('ETB');

      await expect(repo.findAccountById(created.id)).resolves.toEqual(created);
      await expect(
        repo.findAccountByRef({
          type: LedgerAccountType.CUSTOMER_WALLET,
          ownerId: 'user-1',
          currency: 'ETB',
        }),
      ).resolves.toEqual(created);
      await expect(
        repo.findAccountByRef({
          type: LedgerAccountType.CUSTOMER_WALLET,
          ownerId: 'user-2',
          currency: 'ETB',
        }),
      ).resolves.toBeNull();
    });

    it('findOrCreateAccount opens once and then returns the same account', async () => {
      const ref = AccountRef.customerWallet('user-1').toKey();
      const first = await repo.findOrCreateAccount(ref);
      const second = await repo.findOrCreateAccount(ref);

      expect(second.id).toBe(first.id);
      await expect(prisma.ledgerAccount.count()).resolves.toBe(1);
    });

    it('resolves concurrent first-use of the same owner-scoped account to exactly one row', async () => {
      const ref = AccountRef.customerWallet('user-race').toKey();
      const results = await Promise.all([
        repo.findOrCreateAccount(ref),
        repo.findOrCreateAccount(ref),
        repo.findOrCreateAccount(ref),
      ]);

      expect(new Set(results.map((account) => account.id)).size).toBe(1);
      await expect(
        prisma.ledgerAccount.count({ where: { ownerId: 'user-race' } }),
      ).resolves.toBe(1);
    });

    it('resolves concurrent first-use of a PLATFORM account to exactly one row', async () => {
      // The composite (type, ownerId, currency) index cannot dedupe these — ownerId is NULL and
      // Postgres treats NULLs as distinct. The partial `ledger_accounts_platform_type_currency_key`
      // index is what makes this hold; without it, platform revenue would silently split across
      // two accounts.
      const ref = AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE).toKey();
      const results = await Promise.all([
        repo.findOrCreateAccount(ref),
        repo.findOrCreateAccount(ref),
        repo.findOrCreateAccount(ref),
      ]);

      expect(new Set(results.map((account) => account.id)).size).toBe(1);
      await expect(
        prisma.ledgerAccount.count({ where: { type: LedgerAccountType.PLATFORM_REVENUE } }),
      ).resolves.toBe(1);
    });

    it('rejects a second platform account of the same type and currency at the database level', async () => {
      await repo.createAccount({
        type: LedgerAccountType.GATEWAY_CLEARING,
        ownerId: null,
        currency: 'ETB',
      });

      await expect(
        repo.createAccount({
          type: LedgerAccountType.GATEWAY_CLEARING,
          ownerId: null,
          currency: 'ETB',
        }),
      ).rejects.toThrow();
    });
  });

  describe('posting a balanced transaction (§7 rationale, §11.3)', () => {
    it("persists the design's own capture example atomically, and it balances", async () => {
      const accounts = await openCaptureAccounts();
      const reference = uniqueRef('CAPTURE');

      const posted = await ledger.post({
        reference,
        type: LedgerTransactionType.CAPTURE,
        refType: 'payment',
        refId: 'payment-1',
        description: 'Capture for order-1',
        entries: [
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(10_000),
          },
          {
            accountId: accounts.payable,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(9_000),
          },
          {
            accountId: accounts.revenue,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(1_000),
          },
        ],
      });

      expect(posted.transaction.reference).toBe(reference);
      expect(posted.transaction.type).toBe(LedgerTransactionType.CAPTURE);
      expect(posted.transaction.refType).toBe('payment');
      expect(posted.transaction.refId).toBe('payment-1');
      expect(posted.entries).toHaveLength(3);

      // The entries really are in the database, attached to that transaction.
      const persisted = await repo.findEntriesByTransactionId(posted.transaction.id);
      expect(persisted).toHaveLength(3);
      expect(persisted.map((entry) => entry.amount).sort((a, b) => a - b)).toEqual([
        1_000, 9_000, 10_000,
      ]);
      expect(persisted.every((entry) => entry.currency === 'ETB')).toBe(true);

      // Σ debits = Σ credits, read back off the persisted rows.
      const debit = persisted
        .filter((entry) => entry.direction === LedgerDirection.DEBIT)
        .reduce((total, entry) => total + entry.amount, 0);
      const credit = persisted
        .filter((entry) => entry.direction === LedgerDirection.CREDIT)
        .reduce((total, entry) => total + entry.amount, 0);
      expect(debit).toBe(10_000);
      expect(credit).toBe(10_000);
      expect(debit).toBe(credit);

      const readBack = await repo.findTransactionById(posted.transaction.id);
      expect(readBack?.entries).toHaveLength(3);
      await expect(repo.findTransactionByReference(reference)).resolves.toMatchObject({
        id: posted.transaction.id,
      });
    });

    it('derives each account balance from its entries as credits − debits (§5.3)', async () => {
      const accounts = await openCaptureAccounts();
      await ledger.post({
        reference: uniqueRef('CAPTURE'),
        type: LedgerTransactionType.CAPTURE,
        entries: [
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(10_000),
          },
          {
            accountId: accounts.payable,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(9_000),
          },
          {
            accountId: accounts.revenue,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(1_000),
          },
        ],
      });

      await expect(ledger.balanceOf(accounts.gateway)).resolves.toMatchObject({
        amountMinor: -10_000,
      });
      await expect(ledger.balanceOf(accounts.payable)).resolves.toMatchObject({
        amountMinor: 9_000,
      });
      await expect(ledger.balanceOf(accounts.revenue)).resolves.toMatchObject({
        amountMinor: 1_000,
      });

      // Conservation of money: every balance in the ledger sums to zero.
      const balances = await Promise.all(
        Object.values(accounts).map((id) => ledger.balanceOf(id)),
      );
      expect(balances.reduce((total, money) => total + money.amountMinor, 0)).toBe(0);
    });

    it('accumulates multiple postings into the correct derived balance', async () => {
      const accounts = await openCaptureAccounts();
      // A capture posts DEBIT gateway-clearing / CREDIT provider-payable + platform-revenue
      // (§11.3). A zero-value side is omitted rather than posted: the ledger rejects a
      // zero-amount entry, and a posting that records nothing is not a posting.
      const post = async (gross: number, fee: number): Promise<void> => {
        await ledger.post({
          reference: uniqueRef('CAPTURE'),
          type: LedgerTransactionType.CAPTURE,
          entries: [
            {
              accountId: accounts.gateway,
              direction: LedgerDirection.DEBIT,
              amount: Money.base(gross),
            },
            ...(gross - fee > 0
              ? [
                  {
                    accountId: accounts.payable,
                    direction: LedgerDirection.CREDIT,
                    amount: Money.base(gross - fee),
                  },
                ]
              : []),
            ...(fee > 0
              ? [
                  {
                    accountId: accounts.revenue,
                    direction: LedgerDirection.CREDIT,
                    amount: Money.base(fee),
                  },
                ]
              : []),
          ],
        });
      };

      await post(10_000, 1_000);
      await post(25_000, 2_500);
      await post(1, 1); // a one-santim order that is all fee — two entries, still balanced

      // A settlement pays the provider out: DEBIT payable, CREDIT gateway clearing (§11.5).
      await ledger.post({
        reference: uniqueRef('SETTLEMENT'),
        type: LedgerTransactionType.SETTLEMENT,
        entries: [
          {
            accountId: accounts.payable,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(30_000),
          },
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(30_000),
          },
        ],
      });

      // payable: +9 000 +22 500 +0 −30 000 = 1 500
      await expect(ledger.balanceOf(accounts.payable)).resolves.toMatchObject({
        amountMinor: 1_500,
      });
      // revenue: 1 000 + 2 500 + 1 = 3 501
      await expect(ledger.balanceOf(accounts.revenue)).resolves.toMatchObject({
        amountMinor: 3_501,
      });
      // gateway: −10 000 −25 000 −1 +30 000 = −5 001
      await expect(ledger.balanceOf(accounts.gateway)).resolves.toMatchObject({
        amountMinor: -5_001,
      });

      await expect(prisma.ledgerTransaction.count()).resolves.toBe(4);
      await expect(prisma.ledgerEntry.count()).resolves.toBe(10);
    });

    it('keeps the account_balances cache in step with the derived balance (§7)', async () => {
      const accounts = await openCaptureAccounts();
      await ledger.post({
        reference: uniqueRef('WALLET'),
        type: LedgerTransactionType.CAPTURE,
        entries: [
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(7_500),
          },
          {
            accountId: accounts.payable,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(7_500),
          },
        ],
      });

      for (const accountId of [accounts.gateway, accounts.payable]) {
        const derived = await ledger.balanceOf(accountId);
        const cached = await repo.findCachedBalance(accountId);
        expect(cached?.balance).toBe(derived.amountMinor);
        expect(cached?.currency).toBe('ETB');
      }

      // The cache is rebuildable from the entries alone — it holds no information of its own.
      const entries = await repo.findEntriesByAccountId(accounts.payable);
      const rebuilt = entries.reduce(
        (total, entry) =>
          entry.direction === LedgerDirection.CREDIT ? total + entry.amount : total - entry.amount,
        0,
      );
      expect(rebuilt).toBe((await repo.findCachedBalance(accounts.payable))?.balance);
    });
  });

  describe('rejections and atomicity (§9, §12)', () => {
    it('rejects an unbalanced posting before anything is written', async () => {
      const accounts = await openCaptureAccounts();
      const reference = uniqueRef('BAD');

      await expect(
        ledger.post({
          reference,
          type: LedgerTransactionType.CAPTURE,
          entries: [
            {
              accountId: accounts.gateway,
              direction: LedgerDirection.DEBIT,
              amount: Money.base(10_000),
            },
            {
              accountId: accounts.payable,
              direction: LedgerDirection.CREDIT,
              amount: Money.base(9_000),
            },
          ],
        }),
      ).rejects.toMatchObject({ code: ErrorCode.LEDGER_UNBALANCED });

      await expect(prisma.ledgerTransaction.count({ where: { reference } })).resolves.toBe(0);
      await expect(prisma.ledgerEntry.count()).resolves.toBe(0);
    });

    it('leaves zero transaction rows and zero entry rows when a posting fails mid-write', async () => {
      const accounts = await openCaptureAccounts();
      const reference = uniqueRef('ORPHAN');

      // Balanced and structurally valid, so it passes domain validation — but the second entry
      // names an account that does not exist, so the write fails on the foreign key *after* the
      // transaction header would otherwise have been inserted.
      await expect(
        ledger.post({
          reference,
          type: LedgerTransactionType.CAPTURE,
          entries: [
            {
              accountId: accounts.gateway,
              direction: LedgerDirection.DEBIT,
              amount: Money.base(10_000),
            },
            {
              accountId: '00000000-0000-0000-0000-000000000000',
              direction: LedgerDirection.CREDIT,
              amount: Money.base(10_000),
            },
          ],
        }),
      ).rejects.toThrow();

      await expect(prisma.ledgerTransaction.count({ where: { reference } })).resolves.toBe(0);
      await expect(prisma.ledgerEntry.count()).resolves.toBe(0);
      await expect(repo.findTransactionByReference(reference)).resolves.toBeNull();
    });

    it('rolls the whole posting back when the caller-supplied transaction fails afterwards', async () => {
      const accounts = await openCaptureAccounts();
      const reference = uniqueRef('ROLLBACK');

      await expect(
        uow.run(async (tx) => {
          await ledger.post(
            {
              reference,
              type: LedgerTransactionType.CAPTURE,
              entries: [
                {
                  accountId: accounts.gateway,
                  direction: LedgerDirection.DEBIT,
                  amount: Money.base(10_000),
                },
                {
                  accountId: accounts.payable,
                  direction: LedgerDirection.CREDIT,
                  amount: Money.base(10_000),
                },
              ],
            },
            tx,
          );
          throw new Error('the money command failed after posting');
        }),
      ).rejects.toThrow('the money command failed after posting');

      await expect(prisma.ledgerTransaction.count({ where: { reference } })).resolves.toBe(0);
      await expect(prisma.ledgerEntry.count()).resolves.toBe(0);
      await expect(ledger.balanceOf(accounts.payable)).resolves.toMatchObject({ amountMinor: 0 });
    });

    it('rejects a duplicate transaction reference (BRULE-25)', async () => {
      const accounts = await openCaptureAccounts();
      const reference = uniqueRef('DUPLICATE');
      const input: NewLedgerTransactionInput = {
        reference,
        type: LedgerTransactionType.CAPTURE,
        entries: [
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(10_000),
          },
          {
            accountId: accounts.payable,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(10_000),
          },
        ],
      };

      await ledger.post(input);
      await expect(ledger.post(input)).rejects.toMatchObject({ code: 'P2002' });

      await expect(prisma.ledgerTransaction.count({ where: { reference } })).resolves.toBe(1);
      await expect(prisma.ledgerEntry.count()).resolves.toBe(2);
      await expect(ledger.balanceOf(accounts.payable)).resolves.toMatchObject({
        amountMinor: 10_000,
      });
    });

    it('resolves two truly concurrent postings of the same reference to exactly one committed transaction', async () => {
      const accounts = await openCaptureAccounts();
      const reference = uniqueRef('CONCURRENT');
      const input: NewLedgerTransactionInput = {
        reference,
        type: LedgerTransactionType.CAPTURE,
        entries: [
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(10_000),
          },
          {
            accountId: accounts.payable,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(10_000),
          },
        ],
      };

      const results = await Promise.allSettled([ledger.post(input), ledger.post(input)]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await expect(prisma.ledgerTransaction.count({ where: { reference } })).resolves.toBe(1);
      await expect(ledger.balanceOf(accounts.payable)).resolves.toMatchObject({
        amountMinor: 10_000,
      });
    });

    it('rejects a non-positive entry amount at the database level too (defence in depth)', async () => {
      const accounts = await openCaptureAccounts();
      const transaction = await prisma.ledgerTransaction.create({
        data: { reference: uniqueRef('CHECK'), type: LedgerTransactionType.ADJUSTMENT },
      });

      // Bypasses the domain entirely: the `ledger_entries_amount_positive_check` constraint is
      // what stops a zero/negative posting written by any other means.
      for (const amount of [0, -1]) {
        await expect(
          prisma.ledgerEntry.create({
            data: {
              transactionId: transaction.id,
              accountId: accounts.gateway,
              direction: LedgerDirection.DEBIT,
              amount,
              currency: 'ETB',
            },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe('append-only ledger (ADR-006, §13)', () => {
    it('exposes no repository method that updates or deletes a posted transaction or entry', () => {
      const methods = Object.getOwnPropertyNames(PrismaLedgerRepository.prototype);

      expect(methods.sort()).toEqual(
        [
          'constructor',
          'client',
          'findAccountById',
          'findAccountByRef',
          'createAccount',
          'findOrCreateAccount',
          'createTransaction',
          'findTransactionById',
          'findTransactionByReference',
          'findEntriesByTransactionId',
          'findEntriesByAccountId',
          // Added by the wallet task for §9.4's history — a paged *read*, like its neighbours.
          'listEntriesByAccountId',
          // Added by the settlement task: a period-scoped read of one account's entries, and a
          // ledger-wide debit/credit aggregate for reconciliation. Both are reads — the point of
          // this list is that a mutator cannot be added here unnoticed.
          'findEntriesByAccountInPeriod',
          'sumAllEntriesByCurrency',
          'sumEntriesByAccount',
          'findCachedBalance',
          'refreshCachedBalances',
        ].sort(),
      );

      const repository = repo as unknown as Record<string, unknown>;
      for (const forbidden of [
        'updateTransaction',
        'updateEntry',
        'deleteTransaction',
        'deleteEntry',
        'reverseEntry',
        'setBalance',
      ]) {
        expect(repository[forbidden]).toBeUndefined();
      }
    });

    it('rejects an UPDATE or DELETE of a posted transaction or entry, even from raw SQL', async () => {
      const accounts = await openCaptureAccounts();
      const posted = await ledger.post({
        reference: uniqueRef('IMMUTABLE'),
        type: LedgerTransactionType.CAPTURE,
        entries: [
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(10_000),
          },
          {
            accountId: accounts.payable,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(10_000),
          },
        ],
      });
      const entryId = posted.entries[0].id;

      await expect(
        prisma.$executeRaw`UPDATE "ledger_entries" SET "amount" = 1 WHERE "id" = ${entryId}`,
      ).rejects.toThrow(/append-only/i);
      await expect(
        prisma.$executeRaw`DELETE FROM "ledger_entries" WHERE "id" = ${entryId}`,
      ).rejects.toThrow(/append-only/i);
      await expect(
        prisma.$executeRaw`UPDATE "ledger_transactions" SET "description" = 'tampered' WHERE "id" = ${posted.transaction.id}`,
      ).rejects.toThrow(/append-only/i);
      await expect(
        prisma.$executeRaw`DELETE FROM "ledger_transactions" WHERE "id" = ${posted.transaction.id}`,
      ).rejects.toThrow(/append-only/i);

      // Nothing changed, and the balance is untouched.
      const entry = await prisma.ledgerEntry.findUnique({ where: { id: entryId } });
      expect(entry?.amount).toBe(10_000);
      await expect(prisma.ledgerEntry.count()).resolves.toBe(2);
      await expect(ledger.balanceOf(accounts.payable)).resolves.toMatchObject({
        amountMinor: 10_000,
      });
    });

    it('a correction is a compensating posting, never a rewrite', async () => {
      const accounts = await openCaptureAccounts();
      await ledger.post({
        reference: uniqueRef('CAPTURE'),
        type: LedgerTransactionType.CAPTURE,
        entries: [
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(10_000),
          },
          {
            accountId: accounts.payable,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(10_000),
          },
        ],
      });
      await ledger.post({
        reference: uniqueRef('ADJUSTMENT'),
        type: LedgerTransactionType.ADJUSTMENT,
        description: 'reverses the capture above',
        entries: [
          {
            accountId: accounts.payable,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(10_000),
          },
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(10_000),
          },
        ],
      });

      await expect(ledger.balanceOf(accounts.payable)).resolves.toMatchObject({ amountMinor: 0 });
      // Both postings survive: the history shows what happened and what corrected it.
      await expect(prisma.ledgerTransaction.count()).resolves.toBe(2);
      await expect(prisma.ledgerEntry.count()).resolves.toBe(4);
    });
  });

  describe('LedgerService guards reach the database only for legal postings', () => {
    it('a draft that fails validation writes nothing at all', async () => {
      const accounts = await openCaptureAccounts();
      const before = await prisma.ledgerTransaction.count();

      const illegal: NewLedgerTransactionInput[] = [
        { reference: '', type: LedgerTransactionType.CAPTURE, entries: [] },
        {
          reference: uniqueRef('X'),
          type: LedgerTransactionType.CAPTURE,
          entries: [
            {
              accountId: accounts.gateway,
              direction: LedgerDirection.DEBIT,
              amount: Money.base(100),
            },
          ],
        },
        {
          reference: uniqueRef('X'),
          type: LedgerTransactionType.CAPTURE,
          entries: [
            {
              accountId: accounts.gateway,
              direction: LedgerDirection.DEBIT,
              amount: Money.of(100, 'USD'),
            },
            {
              accountId: accounts.payable,
              direction: LedgerDirection.CREDIT,
              amount: Money.of(100, 'ETB'),
            },
          ],
        },
      ];

      for (const input of illegal) {
        await expect(ledger.post(input)).rejects.toThrow();
      }

      await expect(prisma.ledgerTransaction.count()).resolves.toBe(before);
      await expect(prisma.ledgerEntry.count()).resolves.toBe(0);
    });

    it('LedgerTransactionDraft is the only shape createTransaction accepts', async () => {
      const accounts = await openCaptureAccounts();
      const draft = LedgerTransactionDraft.create({
        reference: uniqueRef('DIRECT'),
        type: LedgerTransactionType.WALLET_TOPUP,
        entries: [
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(500),
          },
          {
            accountId: accounts.payable,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(500),
          },
        ],
      });

      const posted = await repo.createTransaction(draft);
      expect(posted.entries).toHaveLength(2);
      expect(posted.transaction.type).toBe(LedgerTransactionType.WALLET_TOPUP);
    });

    it('findPosting reports an unknown transaction as NOT_FOUND', async () => {
      await expect(
        ledger.findPosting('00000000-0000-0000-0000-000000000000'),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('sumEntriesByAccount reports zeroes for an account with no entries yet', async () => {
      const account = await ledger.resolveAccount(AccountRef.customerWallet('user-empty'));
      await expect(repo.sumEntriesByAccount(account.id)).resolves.toEqual({
        debit: 0,
        credit: 0,
        currency: 'ETB',
      });
      await expect(ledger.balanceOf(account.id)).resolves.toMatchObject({ amountMinor: 0 });
    });
  });

  describe('no Prisma type leaks across the repository boundary', () => {
    it('returns plain domain snapshots', async () => {
      const accounts = await openCaptureAccounts();
      const posted = await ledger.post({
        reference: uniqueRef('SNAPSHOT'),
        type: LedgerTransactionType.CAPTURE,
        entries: [
          {
            accountId: accounts.gateway,
            direction: LedgerDirection.DEBIT,
            amount: Money.base(100),
          },
          {
            accountId: accounts.payable,
            direction: LedgerDirection.CREDIT,
            amount: Money.base(100),
          },
        ],
      });

      expect(Object.keys(posted.transaction).sort()).toEqual(
        ['id', 'reference', 'type', 'refType', 'refId', 'description', 'createdAt'].sort(),
      );
      expect(Object.keys(posted.entries[0]).sort()).toEqual(
        ['id', 'transactionId', 'accountId', 'direction', 'amount', 'currency', 'createdAt'].sort(),
      );
      expect(posted.transaction).not.toBeInstanceOf(Prisma.Decimal);
    });
  });
});
