import { createDomainEvent, DomainEvent } from '../../../../shared/events/domain-event';
import { EventBusService } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { DeliveryEventType, JobCreatedPayload, jobCreatedEvent } from '../../../delivery/domain/events';
import {
  DeliveryJobLinkInput,
  DeliveryJobLinkOutcome,
  IFulfillmentDeliveryJobLinkRepository,
} from '../../domain/repositories/fulfillment-delivery-job-link.repository';
import { DELIVERY_JOB_REFERENCE_REPAIR, DeliveryJobCreatedHandler } from './delivery-job-created.handler';

const JOB = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const FUL = '33333333-3333-4333-8333-333333333333';
const payload = (over: Partial<JobCreatedPayload> = {}): JobCreatedPayload => ({
  jobId: JOB, orderId: ORDER, fulfillmentId: FUL, pharmacyId: 'ph', branchId: 'br', isColdChain: false, isCod: true, ...over,
});

function fakeLogger() {
  const lines: Array<{ level: string; entry: Record<string, unknown> }> = [];
  const logger = {
    setContext: () => undefined,
    log: (entry: Record<string, unknown>) => lines.push({ level: 'log', entry }),
    warn: (entry: Record<string, unknown>) => lines.push({ level: 'warn', entry }),
    error: (entry: Record<string, unknown>) => lines.push({ level: 'error', entry }),
  } as unknown as AppLogger;
  return { logger, lines };
}

describe('DeliveryJobCreatedHandler (Module 06)', () => {
  let calls: DeliveryJobLinkInput[];
  let outcome: DeliveryJobLinkOutcome | Error;
  let handler: DeliveryJobCreatedHandler;
  let lines: ReturnType<typeof fakeLogger>['lines'];

  beforeEach(() => {
    calls = [];
    outcome = 'LINKED';
    const links: IFulfillmentDeliveryJobLinkRepository = {
      link: async (input) => {
        calls.push(input);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
    const fake = fakeLogger();
    lines = fake.lines;
    handler = new DeliveryJobCreatedHandler({ subscribe: () => undefined, publish: async () => undefined }, links, fake.logger);
  });

  it('subscribes to Module 08’s existing delivery.job.created event — no event of its own', () => {
    const subscribed: string[] = [];
    const h = new DeliveryJobCreatedHandler({ subscribe: (type: string) => subscribed.push(type), publish: async () => undefined }, { link: async () => 'LINKED' }, fakeLogger().logger);
    h.onModuleInit();
    expect(subscribed).toEqual([DeliveryEventType.JobCreated]);
    expect(DeliveryEventType.JobCreated).toBe('delivery.job.created');
  });

  it('a valid event links the fulfillment named by fulfillmentId to the job, checked against the event’s orderId', async () => {
    await handler.handle(jobCreatedEvent(payload()));
    expect(calls).toEqual([{ fulfillmentId: FUL, orderId: ORDER, deliveryJobId: JOB }]);
    expect(lines.map((l) => [l.level, l.entry.message])).toEqual([['log', 'Delivery job reference recorded on fulfillment']]);
  });

  it('a redelivered event is a successful no-change (ALREADY_LINKED), logged as such', async () => {
    outcome = 'ALREADY_LINKED';
    await handler.handle(jobCreatedEvent(payload()));
    expect(lines).toEqual([{ level: 'log', entry: expect.objectContaining({ message: 'Delivery job reference already recorded' }) }]);
  });

  it.each(['CONFLICT', 'ORDER_MISMATCH', 'FULFILLMENT_NOT_FOUND'] as const)('%s is surfaced as an error naming ids only and the repair command — never thrown, never retried here', async (o) => {
    outcome = o;
    await expect(handler.handle(jobCreatedEvent(payload()))).resolves.toBeUndefined();
    expect(lines).toEqual([
      { level: 'error', entry: { message: 'Delivery job reference not recorded on fulfillment', outcome: o, fulfillmentId: FUL, orderId: ORDER, jobId: JOB, repair: DELIVERY_JOB_REFERENCE_REPAIR } },
    ]);
  });

  it('a malformed or incomplete payload writes nothing and logs only the event id', async () => {
    for (const bad of [{ jobId: '' }, { fulfillmentId: undefined }, { orderId: 'ORD-1' }, { jobId: 42 as unknown as string }]) {
      await handler.handle(jobCreatedEvent(payload(bad)));
    }
    await handler.handle({ id: 'evt-1', type: DeliveryEventType.JobCreated } as unknown as DomainEvent<JobCreatedPayload>);
    expect(calls).toEqual([]);
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(Object.keys(l.entry).sort()).toEqual(['eventId', 'message']);
  });

  it('a persistence exception is caught and logged with the repair command; the handler resolves', async () => {
    outcome = new Error('connection reset');
    await expect(handler.handle(jobCreatedEvent(payload()))).resolves.toBeUndefined();
    expect(lines[0]).toEqual({ level: 'error', entry: expect.objectContaining({ message: 'Failed to record delivery job reference on fulfillment', error: 'connection reset', repair: DELIVERY_JOB_REFERENCE_REPAIR }) });
  });

  it('through the real EventBusService: the handler runs once per publish — the bus does not retry, so recovery is the repair script', async () => {
    const { logger } = fakeLogger();
    const bus = new EventBusService(logger);
    let attempts = 0;
    const h = new DeliveryJobCreatedHandler(bus, { link: async () => { attempts += 1; throw new Error('boom'); } }, fakeLogger().logger);
    h.onModuleInit();
    await bus.publish(jobCreatedEvent(payload()));
    expect(attempts).toBe(1);
    // A different event type does not reach it.
    await bus.publish(createDomainEvent({ type: 'delivery.job.offered', aggregateType: 'DeliveryJob', aggregateId: JOB, payload: payload() }));
    expect(attempts).toBe(1);
  });

  it('its only collaborator is the link repository: it cannot change statuses, write audit entries or emit events', () => {
    expect(DeliveryJobCreatedHandler.length).toBe(3); // bus, link repository, logger
  });
});
