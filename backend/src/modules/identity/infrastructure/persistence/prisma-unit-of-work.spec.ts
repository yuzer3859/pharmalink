import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { PrismaUnitOfWork } from './prisma-unit-of-work';

function build(outcomes: Array<'ok' | 'conflict' | 'other'>) {
  const options: unknown[] = [];
  let call = 0;
  const prisma = {
    $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
      options.push(opts);
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      if (outcome === 'conflict') throw Object.assign(new Error('could not serialize'), { code: 'P2034' });
      if (outcome === 'other') throw new Error('boom');
      return work('tx');
    }),
  } as unknown as PrismaService;
  return { uow: new PrismaUnitOfWork(prisma), prisma, options };
}

describe('PrismaUnitOfWork', () => {
  it('keeps the default isolation and does not retry unless asked', async () => {
    const m = build(['conflict']);
    await expect(m.uow.run(async () => 'x')).rejects.toThrow('could not serialize');
    expect(m.options).toEqual([undefined]);
  });

  it('runs serializable units at Serializable and retries a serialization failure', async () => {
    const m = build(['conflict', 'ok']);
    await expect(m.uow.run(async (tx) => tx, { isolation: 'serializable' })).resolves.toBe('tx');
    expect(m.options).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ]);
  });

  it('gives up after three attempts and never retries other errors', async () => {
    const conflicts = build(['conflict', 'conflict', 'conflict', 'ok']);
    await expect(conflicts.uow.run(async () => 'x', { isolation: 'serializable' })).rejects.toThrow('could not serialize');
    expect(conflicts.options).toHaveLength(3);

    const other = build(['other', 'ok']);
    await expect(other.uow.run(async () => 'x', { isolation: 'serializable' })).rejects.toThrow('boom');
    expect(other.options).toHaveLength(1);
  });
});
