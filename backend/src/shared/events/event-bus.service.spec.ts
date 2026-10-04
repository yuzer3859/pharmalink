import { AppLogger } from '../logging/app-logger.service';
import { createDomainEvent } from './domain-event';
import { EventBusService } from './event-bus.service';

function fakeLogger(): AppLogger {
  return {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  } as unknown as AppLogger;
}

describe('EventBusService', () => {
  it('delivers an event to all subscribed handlers', async () => {
    const bus = new EventBusService(fakeLogger());
    const received: string[] = [];
    bus.subscribe<{ id: string }>('order.placed', (e) => {
      received.push(`a:${e.payload.id}`);
    });
    bus.subscribe<{ id: string }>('order.placed', (e) => {
      received.push(`b:${e.payload.id}`);
    });

    await bus.publish(
      createDomainEvent({
        type: 'order.placed',
        aggregateType: 'order',
        aggregateId: 'o1',
        payload: { id: 'o1' },
      }),
    );

    expect(received.sort()).toEqual(['a:o1', 'b:o1']);
  });

  it('does not deliver to handlers of other event types', async () => {
    const bus = new EventBusService(fakeLogger());
    const handler = jest.fn();
    bus.subscribe('payment.captured', handler);

    await bus.publish(
      createDomainEvent({
        type: 'order.placed',
        aggregateType: 'order',
        aggregateId: 'o1',
        payload: {},
      }),
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it('isolates a failing handler so siblings still run', async () => {
    const bus = new EventBusService(fakeLogger());
    const good = jest.fn();
    bus.subscribe('x.happened', () => {
      throw new Error('boom');
    });
    bus.subscribe('x.happened', good);

    await expect(
      bus.publish(
        createDomainEvent({
          type: 'x.happened',
          aggregateType: 'x',
          aggregateId: '1',
          payload: {},
        }),
      ),
    ).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('tracks handler counts', () => {
    const bus = new EventBusService(fakeLogger());
    bus.subscribe('a', () => undefined);
    bus.subscribe('a', () => undefined);
    expect(bus.handlerCount('a')).toBe(2);
    expect(bus.handlerCount('missing')).toBe(0);
  });
});
