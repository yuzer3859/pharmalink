import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import {
  createPharmacyOrdersService,
  declineReasonProblem,
  FULFILLMENT_STATUSES,
  nextActions,
  pharmacyOrderQuery,
  stageLabel,
} from './pharmacyOrders.service';

describe('pharmacyOrderQuery', () => {
  it('sends only the filters that are set, and never more than the server allows', () => {
    expect(pharmacyOrderQuery({})).toBe('');
    expect(pharmacyOrderQuery({ status: 'all' })).toBe('');
    expect(pharmacyOrderQuery({ status: 'PENDING', page: 2, size: 25 })).toBe('?status=PENDING&page=2&size=25');
    expect(pharmacyOrderQuery({ size: 200 })).toBe('?size=50');
  });
});

describe('nextActions', () => {
  it('follows the fulfilment policy: accept or decline, then prepare, then ready, then nothing', () => {
    expect(nextActions('PENDING')).toEqual(['accept', 'decline']);
    expect(nextActions('ACCEPTED')).toEqual(['prepare']);
    expect(nextActions('PREPARING')).toEqual(['ready']);
    for (const status of ['READY', 'DISPATCHED', 'DELIVERED', 'CANCELLED'] as const) {
      expect(nextActions(status)).toEqual([]);
    }
  });

  it('has a plain stage label for every status', () => {
    for (const status of FULFILLMENT_STATUSES) expect(stageLabel(status).length).toBeGreaterThan(3);
    expect(stageLabel('READY')).toMatch(/driver/);
  });
});

describe('declineReasonProblem', () => {
  it('follows the server rule: 3 to 500 characters after trimming', () => {
    expect(declineReasonProblem('')).not.toBeNull();
    expect(declineReasonProblem('  ab ')).not.toBeNull();
    expect(declineReasonProblem('Out of stock')).toBeNull();
    expect(declineReasonProblem('x'.repeat(501))).not.toBeNull();
  });
});

describe('pharmacyOrdersService', () => {
  it('lists and reads from /pharmacy/orders', async () => {
    const request = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const service = createPharmacyOrdersService(request as unknown as SessionRequest);

    await service.list({ status: 'READY', page: 1, size: 10 });
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders?status=READY&page=1&size=10', { method: 'GET' });

    await service.get('f/1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders/f%2F1', { method: 'GET' });
  });

  it('posts each action to its route, and the decline with its trimmed reason', async () => {
    const request = vi.fn().mockResolvedValue({});
    const service = createPharmacyOrdersService(request as unknown as SessionRequest);

    await service.accept('f-1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders/f-1/accept', { method: 'POST' });
    await service.prepare('f-1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders/f-1/prepare', { method: 'POST' });
    await service.ready('f-1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders/f-1/ready', { method: 'POST' });
    await service.decline('f-1', '  Out of stock ');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders/f-1/decline', { method: 'POST', body: { reason: 'Out of stock' } });
  });

  it('offers no other operation', () => {
    const service = createPharmacyOrdersService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(service).sort()).toEqual(['accept', 'decline', 'get', 'list', 'prepare', 'ready']);
  });
});
