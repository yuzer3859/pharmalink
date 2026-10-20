import { OrderCancellationReconciler } from './order-cancellation.reconciler';

describe('OrderCancellationReconciler (Work 55)', () => {
  const due = (ids: string[]) => ids.map((id) => ({ id }));

  it('resumes every due request through the workflow and counts each outcome', async () => {
    const requests = { listDue: jest.fn().mockResolvedValue(due(['a', 'b', 'c', 'd', 'e', 'f'])) };
    const outcomes: Record<string, string> = { a: 'COMPLETED', b: 'ORDER_CANCELLED', c: 'REJECTED', d: 'PENDING', e: 'ATTENTION', f: 'BUSY' };
    const workflow = { resume: jest.fn(async (id: string) => outcomes[id]) };
    const report = await new OrderCancellationReconciler(requests as never, workflow as never).run(10);
    expect(requests.listDue).toHaveBeenCalledWith(expect.any(Date), 10);
    expect(workflow.resume.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(report).toEqual({ examined: 6, completed: 1, cancelledCouponPending: 1, rejected: 1, retryScheduled: 1, attention: 1, busy: 1, failures: 0 });
  });

  it('never throws: a failed read or a failed request is counted and the rest continue', async () => {
    const broken = new OrderCancellationReconciler({ listDue: jest.fn().mockRejectedValue(new Error('db down')) } as never, { resume: jest.fn() } as never);
    expect(await broken.run()).toMatchObject({ examined: 0, failures: 1 });

    const workflow = { resume: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('COMPLETED') };
    const report = await new OrderCancellationReconciler({ listDue: jest.fn().mockResolvedValue(due(['x', 'y'])) } as never, workflow as never).run();
    expect(report).toMatchObject({ examined: 2, failures: 1, completed: 1 });
  });

  it('an overlapping run in the same process returns at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const workflow = { resume: jest.fn(async () => { await gate; return 'COMPLETED'; }) };
    const reconciler = new OrderCancellationReconciler({ listDue: jest.fn().mockResolvedValue(due(['a'])) } as never, workflow as never);
    const first = reconciler.run();
    await new Promise((r) => setImmediate(r));
    expect(await reconciler.run()).toMatchObject({ examined: 0 });
    release();
    expect(await first).toMatchObject({ completed: 1 });
    expect(workflow.resume).toHaveBeenCalledTimes(1);
  });
});
