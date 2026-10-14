import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DeliveryJobReference, IDeliveryJobReferenceReadPort, MAX_DELIVERY_JOB_REFERENCE_LOOKUP } from '../../../delivery/application/ports/inbound/delivery-job-reference-read.port';
import { PrismaDeliveryJobReferenceReadAdapter } from '../../../delivery/infrastructure/persistence/prisma-delivery-job-reference-read.adapter';
import { linkDeliveryJobReference } from '../../application/services/delivery-job-reference-linker';
import { FulfillmentStatus } from '../../domain/enums';
import {
  DELIVERY_JOB_REFERENCE_ELIGIBLE_STATUSES,
  DeliveryJobReferenceCandidate,
  IDeliveryJobReferenceCandidateRepository,
} from '../../domain/repositories/delivery-job-reference-candidate.repository';
import { DeliveryJobLinkInput, IFulfillmentDeliveryJobLinkRepository } from '../../domain/repositories/fulfillment-delivery-job-link.repository';
import { FulfillmentStatusPolicy } from '../../domain/services/fulfillment-status-policy';
import { DeliveryJobCreatedHandler } from '../../interface/events/delivery-job-created.handler';
import { PrismaDeliveryJobReferenceCandidateRepository } from '../persistence/prisma-delivery-job-reference-candidate.repository';
import { DELIVERY_JOB_REFERENCE_RECONCILE_BATCH_SIZE, DeliveryJobReferenceReconciler } from './delivery-job-reference.reconciler';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORDER = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOB = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * An in-memory world: Module 06 fulfillments (status, reference) and Module 08 jobs by fulfillment.
 * The link double is the real compare-and-set semantics: set only when null and the order matches.
 */
function world(fulfillments: Array<{ n: number; status?: FulfillmentStatus; ref?: string | null; order?: number }>, jobs: Array<{ f: number; job: number; order?: number }>) {
  const rows = new Map(fulfillments.map((f) => [id(f.n), { id: id(f.n), orderId: ORDER(f.order ?? f.n), status: f.status ?? FulfillmentStatus.READY, deliveryJobId: f.ref ?? null }]));
  const jobRows = jobs.map((j) => ({ jobId: JOB(j.job), fulfillmentId: id(j.f), orderId: ORDER(j.order ?? j.f) }));
  const calls = { candidatePages: [] as Array<[string | null, number]>, lookups: [] as string[][], links: [] as DeliveryJobLinkInput[] };
  const candidates: IDeliveryJobReferenceCandidateRepository = {
    listUnreferenced: async (afterId, limit) => {
      calls.candidatePages.push([afterId, limit]);
      return [...rows.values()]
        .filter((r) => r.deliveryJobId === null && DELIVERY_JOB_REFERENCE_ELIGIBLE_STATUSES.includes(r.status) && (afterId === null || r.id > afterId))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((r): DeliveryJobReferenceCandidate => ({ fulfillmentId: r.id, orderId: r.orderId }));
    },
  };
  const lookup: IDeliveryJobReferenceReadPort = {
    findByFulfillmentIds: async (ids) => (calls.lookups.push([...ids]), jobRows.filter((j) => ids.includes(j.fulfillmentId))),
  };
  const links: IFulfillmentDeliveryJobLinkRepository = {
    link: async (input) => {
      calls.links.push(input);
      await Promise.resolve();
      const r = rows.get(input.fulfillmentId);
      if (!r) return 'FULFILLMENT_NOT_FOUND';
      if (r.orderId !== input.orderId) return 'ORDER_MISMATCH';
      if (r.deliveryJobId === null) {
        r.deliveryJobId = input.deliveryJobId;
        return 'LINKED';
      }
      return r.deliveryJobId === input.deliveryJobId ? 'ALREADY_LINKED' : 'CONFLICT';
    },
  };
  const lines: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const logger = {
    setContext: () => undefined,
    log: (entry: Record<string, unknown>) => lines.push({ level: 'log', entry }),
    error: (entry: Record<string, unknown>) => lines.push({ level: 'error', entry }),
    warn: (entry: Record<string, unknown>) => lines.push({ level: 'warn', entry }),
  } as unknown as AppLogger;
  return { rows, calls, candidates, lookup, links, logger, lines, reconciler: () => new DeliveryJobReferenceReconciler(candidates, lookup, links, logger) };
}

describe('DeliveryJobReferenceReconciler (Work 45)', () => {
  it('eligibility follows the lifecycle: READY and the two post-handoff states — nothing before READY can carry a job, and CANCELLED is only reachable before READY', () => {
    expect([...DELIVERY_JOB_REFERENCE_ELIGIBLE_STATUSES]).toEqual(['READY', 'DISPATCHED', 'DELIVERED']);
    // CANCELLED is entered only from states before READY.
    const into = (to: FulfillmentStatus) => Object.values(FulfillmentStatus).filter((from) => FulfillmentStatusPolicy.isLegalTransition(from, to));
    expect(into(FulfillmentStatus.CANCELLED)).toEqual(['PENDING', 'ACCEPTED']);
  });

  it('a real matching job populates the reference; a fulfillment with no job is left unchanged; ineligible and already-referenced rows are never candidates', async () => {
    const w = world(
      [{ n: 1 }, { n: 2 }, { n: 3, status: FulfillmentStatus.PREPARING }, { n: 4, status: FulfillmentStatus.CANCELLED }, { n: 5, ref: JOB(5) }],
      [{ f: 1, job: 1 }, { f: 3, job: 3 }, { f: 5, job: 5 }],
    );
    const report = await w.reconciler().run();
    expect(report).toEqual({ examined: 2, populated: 1, alreadyCorrect: 0, conflicts: 0, orderMismatches: 0, noJob: 1, failures: 0 });
    expect(w.rows.get(id(1))!.deliveryJobId).toBe(JOB(1));
    expect(w.rows.get(id(2))!.deliveryJobId).toBeNull();
    expect(w.rows.get(id(3))!.deliveryJobId).toBeNull(); // PREPARING: never selected even though a job row exists
    expect(w.calls.lookups).toEqual([[id(1), id(2)]]); // one lookup, only the candidates
  });

  it('the job’s own orderId is checked: a job cut for another order is refused; an existing different reference is never overwritten', async () => {
    const w = world([{ n: 1 }], [{ f: 1, job: 1, order: 99 }]);
    expect(await w.reconciler().run()).toMatchObject({ orderMismatches: 1, populated: 0 });
    expect(w.rows.get(id(1))!.deliveryJobId).toBeNull();
    // A reference written by someone else between selection and link: CONFLICT, kept.
    const v = world([{ n: 1 }], [{ f: 1, job: 1 }]);
    const r = v.reconciler();
    const realLink = v.links.link;
    v.links.link = async (input) => ((v.rows.get(id(1))!.deliveryJobId = JOB(7)), realLink(input));
    expect(await r.run()).toMatchObject({ conflicts: 1 });
    expect(v.rows.get(id(1))!.deliveryJobId).toBe(JOB(7));
    expect(v.lines.find((l) => l.entry.outcome === 'CONFLICT')!.entry).toEqual({ message: 'Delivery job reference not reconciled', outcome: 'CONFLICT', fulfillmentId: id(1), jobId: JOB(1) });
  });

  it('the handler and the reconciler share one rule: both call linkDeliveryJobReference, so the same input gives the same outcome', async () => {
    for (const scenario of ['LINKED', 'ALREADY_LINKED', 'CONFLICT', 'ORDER_MISMATCH'] as const) {
      const a = world([{ n: 1, ref: scenario === 'ALREADY_LINKED' ? JOB(1) : scenario === 'CONFLICT' ? JOB(9) : null }], []);
      const input = { fulfillmentId: id(1), orderId: scenario === 'ORDER_MISMATCH' ? ORDER(42) : ORDER(1), deliveryJobId: JOB(1) };
      expect(await linkDeliveryJobReference(a.links, input)).toBe(scenario);
    }
    expect(await linkDeliveryJobReference(world([], []).links, { fulfillmentId: 'x', orderId: ORDER(1), deliveryJobId: JOB(1) })).toBe('INVALID');
    const src = (p: string) => readFileSync(join(__dirname, p), 'utf8');
    expect(src('./delivery-job-reference.reconciler.ts')).toContain('linkDeliveryJobReference(this.links');
    expect(src('../../interface/events/delivery-job-created.handler.ts')).toContain('linkDeliveryJobReference(this.links');
    expect(src('../../interface/events/delivery-job-created.handler.ts')).not.toContain('this.links.link(');
    expect(DeliveryJobCreatedHandler.length).toBe(3);
  });

  it('bounded batches with a keyset cursor that moves on and wraps: job-less fulfillments do not starve later ones', async () => {
    // Fulfillments 1..5 never get a job; 6 has one. Batch of 2.
    const w = world([1, 2, 3, 4, 5, 6].map((n) => ({ n })), [{ f: 6, job: 6 }]);
    const r = w.reconciler();
    const runs = [];
    for (let i = 0; i < 4; i += 1) runs.push(await r.run(2));
    expect(w.calls.candidatePages).toEqual([[null, 2], [id(2), 2], [id(4), 2], [id(6), 2], [null, 2]]); // the empty page after id 6 wraps within the same run
    expect(runs.map((x) => x.examined)).toEqual([2, 2, 2, 2]);
    expect(runs[2].populated).toBe(1);
    expect(w.rows.get(id(6))!.deliveryJobId).toBe(JOB(6));
    expect(w.calls.lookups.every((l) => l.length <= 2)).toBe(true);
    expect(DELIVERY_JOB_REFERENCE_RECONCILE_BATCH_SIZE).toBeLessThanOrEqual(MAX_DELIVERY_JOB_REFERENCE_LOOKUP);
  });

  it('overlapping runs in one process: the second returns at once; a later run is an idempotent no-op', async () => {
    const w = world([{ n: 1 }, { n: 2 }], [{ f: 1, job: 1 }, { f: 2, job: 2 }]);
    const r = w.reconciler();
    const [a, b] = await Promise.all([r.run(), r.run()]);
    expect([a.populated, b.examined]).toEqual([2, 0]);
    const again = await w.reconciler().run();
    expect(again).toMatchObject({ examined: 0, populated: 0 }); // nothing unreferenced remains
    expect(w.calls.links).toHaveLength(2);
  });

  it('two instances racing on the same page: each job recorded once, the loser sees ALREADY_LINKED', async () => {
    const w = world([{ n: 1 }], [{ f: 1, job: 1 }]);
    const [a, b] = await Promise.all([w.reconciler().run(), w.reconciler().run()]);
    expect([a.populated + b.populated, a.alreadyCorrect + b.alreadyCorrect]).toEqual([1, 1]);
    expect(w.rows.get(id(1))!.deliveryJobId).toBe(JOB(1));
  });

  it('one record’s failure does not stop the rest of the page', async () => {
    const w = world([{ n: 1 }, { n: 2 }, { n: 3 }], [{ f: 1, job: 1 }, { f: 2, job: 2 }, { f: 3, job: 3 }]);
    const realLink = w.links.link;
    w.links.link = async (input) => (input.fulfillmentId === id(2) ? Promise.reject(new Error('deadlock detected')) : realLink(input));
    const report = await w.reconciler().run();
    expect(report).toMatchObject({ examined: 3, populated: 2, failures: 1 });
    expect([w.rows.get(id(1))!.deliveryJobId, w.rows.get(id(2))!.deliveryJobId, w.rows.get(id(3))!.deliveryJobId]).toEqual([JOB(1), null, JOB(3)]);
  });

  it('a transient read failure is logged, never thrown, keeps the cursor — and the next run recovers', async () => {
    const w = world([{ n: 1 }], [{ f: 1, job: 1 }]);
    const r = w.reconciler();
    const realLookup = w.lookup.findByFulfillmentIds;
    w.lookup.findByFulfillmentIds = async () => Promise.reject(new Error('connection terminated'));
    await expect(r.run()).resolves.toEqual({ examined: 0, populated: 0, alreadyCorrect: 0, conflicts: 0, orderMismatches: 0, noJob: 0, failures: 1 });
    expect(w.lines[0]).toEqual({ level: 'error', entry: { message: 'Delivery job reference reconciliation failed to read a batch; it will be retried', error: 'connection terminated' } });
    w.lookup.findByFulfillmentIds = realLookup;
    expect(await r.run()).toMatchObject({ populated: 1 });
    expect(w.calls.candidatePages.map((p) => p[0])).toEqual([null, null]);
  });

  it('logs carry only ids, outcomes and counters — no personal, address or provider data', async () => {
    const w = world([{ n: 1 }, { n: 2 }], [{ f: 1, job: 1 }, { f: 2, job: 2, order: 77 }]);
    await w.reconciler().run();
    const allowed = new Set(['message', 'outcome', 'fulfillmentId', 'jobId', 'error', 'examined', 'populated', 'alreadyCorrect', 'conflicts', 'orderMismatches', 'noJob', 'failures']);
    for (const l of w.lines) for (const k of Object.keys(l.entry)) expect({ k, ok: allowed.has(k) }).toEqual({ k, ok: true });
    expect(w.lines.find((l) => l.entry.message === 'Delivery job reference reconciliation run')!.entry).toMatchObject({ examined: 2, populated: 1, orderMismatches: 1 });
  });

  describe('adapters', () => {
    it('Module 06 candidates: one bounded keyset query on its own fulfillments — eligible statuses, null reference, id > cursor, ascending', async () => {
      const args: unknown[] = [];
      const prisma = { fulfillment: { findMany: async (a: unknown) => (args.push(a), [{ id: id(3), orderId: ORDER(3) }]) } } as unknown as PrismaService;
      const repo = new PrismaDeliveryJobReferenceCandidateRepository(prisma);
      expect(await repo.listUnreferenced(id(2), 50)).toEqual([{ fulfillmentId: id(3), orderId: ORDER(3) }]);
      await repo.listUnreferenced(null, 50);
      expect(args).toEqual([
        { where: { deliveryJobId: null, status: { in: ['READY', 'DISPATCHED', 'DELIVERED'] }, id: { gt: id(2) } }, select: { id: true, orderId: true }, orderBy: { id: 'asc' }, take: 50 },
        { where: { deliveryJobId: null, status: { in: ['READY', 'DISPATCHED', 'DELIVERED'] } }, select: { id: true, orderId: true }, orderBy: { id: 'asc' }, take: 50 },
      ]);
    });

    it('Module 08 lookup: one IN query on the unique fulfillmentId, identifiers only; bounded; empty asks nothing; it cannot write', async () => {
      const args: unknown[] = [];
      const prisma = { deliveryJob: { findMany: async (a: unknown) => (args.push(a), [{ id: JOB(1), fulfillmentId: id(1), orderId: ORDER(1) }]) } } as unknown as PrismaService;
      const port = new PrismaDeliveryJobReferenceReadAdapter(prisma);
      expect(await port.findByFulfillmentIds([id(1)])).toEqual<DeliveryJobReference[]>([{ jobId: JOB(1), fulfillmentId: id(1), orderId: ORDER(1) }]);
      expect(args).toEqual([{ where: { fulfillmentId: { in: [id(1)] } }, select: { id: true, fulfillmentId: true, orderId: true } }]);
      expect(await port.findByFulfillmentIds([])).toEqual([]);
      await expect(port.findByFulfillmentIds(Array.from({ length: MAX_DELIVERY_JOB_REFERENCE_LOOKUP + 1 }, (_, i) => id(i)))).rejects.toThrow(/At most/);
      expect(Object.getOwnPropertyNames(PrismaDeliveryJobReferenceReadAdapter.prototype).filter((m) => m !== 'constructor')).toEqual(['findByFulfillmentIds']);
    });
  });

  it('boundaries: Module 06 reaches Module 08 only through inbound ports and the event contract; Module 08 never writes fulfillments', () => {
    const walk = (dir: string, out: string[] = []) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
      }
      return out;
    };
    const ordersRoot = join(__dirname, '..', '..');
    const deliveryImports = new Set<string>();
    for (const f of walk(ordersRoot)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from '((?:\.\.\/)+delivery\/[^']*)'/g)) deliveryImports.add(m[1].replace(/^(\.\.\/)+/, ''));
    }
    expect([...deliveryImports].sort()).toEqual([
      'delivery/application/ports/inbound/delivery-job-reference-read.port',
      'delivery/application/ports/inbound/delivery-pricing.port',
      'delivery/delivery.module',
      'delivery/domain/events',
    ]);
    const deliveryRoot = join(__dirname, '..', '..', '..', 'delivery');
    for (const f of walk(deliveryRoot)) {
      expect({ f, writes: /fulfillment\.(update|updateMany|upsert|create)\(/.test(readFileSync(f, 'utf8')) }).toEqual({ f, writes: false });
    }
  });
});
