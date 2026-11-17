import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import {
  createPharmacyOrdersService,
  declineReasonProblem,
  FULFILLMENT_STATUSES,
  nextActions,
  orderStageLabel,
  paperCheckable,
  paperStage,
  paymentLabel,
  pharmacyOrderQuery,
  rejectReasonProblem,
  stageLabel,
  type PharmacyOrder,
} from './pharmacyOrders.service';

const withOrder = (order: Partial<PharmacyOrder['order']>, status: PharmacyOrder['status'] = 'PENDING') => ({
  status,
  order: { orderNumber: 'PL-1', status: 'PAID', isCod: false, grandTotal: 1000, currency: 'ETB', placedAt: null, deliverySlot: null, ...order },
});

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

  it('offers nothing while the prescription waits for review: the review is the decision (Work 132)', () => {
    expect(nextActions('PENDING', 'PENDING')).toEqual([]);
    expect(nextActions('PENDING', 'APPROVED')).toEqual(['accept', 'decline']);
    expect(nextActions('PENDING', null)).toEqual(['accept', 'decline']);
    // Approved but not paid yet: the customer pays first.
    expect(nextActions('PENDING', 'APPROVED', 'PENDING_PAYMENT')).toEqual([]);
    expect(nextActions('PENDING', 'APPROVED', 'PAID')).toEqual(['accept', 'decline']);
  });

  it('says where an order with a prescription is, including the payment after the approval', () => {
    expect(orderStageLabel(withOrder({ rxReviewStatus: 'PENDING', status: 'PENDING_PAYMENT' }))).toMatch(/review/);
    expect(orderStageLabel(withOrder({ rxReviewStatus: 'APPROVED', status: 'PENDING_PAYMENT' }))).toMatch(/customer to pay/);
    expect(orderStageLabel(withOrder({ rxReviewStatus: 'REJECTED', status: 'CANCELLED' }, 'CANCELLED'))).toMatch(/rejected/);
    expect(orderStageLabel(withOrder({ rxReviewStatus: 'APPROVED' }))).toBe(stageLabel('PENDING'));
    expect(paymentLabel(withOrder({ isCod: true, status: 'PENDING_PAYMENT' }))).toBe('COD');
    expect(paymentLabel(withOrder({ status: 'PENDING_PAYMENT' }))).toBe('Not paid yet');
    expect(paymentLabel(withOrder({ status: 'PAID' }))).toBe('Paid');
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

describe('the original paper prescription (Work 137)', () => {
  const paper = (over: Partial<NonNullable<PharmacyOrder['paper']>> = {}) => ({ collectedAt: null, driverAtPharmacy: false, verifiedAt: null, ...over });

  it('blocks preparing until the paper is checked', () => {
    expect(nextActions('ACCEPTED', null, 'PAID', paper())).toEqual([]);
    expect(nextActions('ACCEPTED', null, 'PAID', paper({ verifiedAt: '2026-11-18T10:00:00Z' }))).toEqual(['prepare']);
    expect(nextActions('ACCEPTED', null, 'PAID', null)).toEqual(['prepare']);
    expect(nextActions('PENDING', null, 'PAID', paper())).toEqual(['accept', 'decline']);
  });

  it('can be checked only with the driver here with it, once', () => {
    expect(paperCheckable({ status: 'ACCEPTED', paper: paper({ collectedAt: 'x', driverAtPharmacy: true }) })).toBe(true);
    expect(paperCheckable({ status: 'ACCEPTED', paper: paper({ collectedAt: 'x' }) })).toBe(false);
    expect(paperCheckable({ status: 'ACCEPTED', paper: paper({ collectedAt: 'x', driverAtPharmacy: true, verifiedAt: 'y' }) })).toBe(false);
    expect(paperCheckable({ status: 'ACCEPTED', paper: null })).toBe(false);
    expect(paperStage({ status: 'ACCEPTED', paper: paper({ collectedAt: 'x', driverAtPharmacy: true }) })).toMatch(/check it/);
    expect(paperStage({ status: 'ACCEPTED', paper: paper({ collectedAt: 'x' }) })).toMatch(/on the way/);
    expect(paperStage({ status: 'ACCEPTED', paper: paper({ verifiedAt: 'y' }) })).toMatch(/Prepare/);
  });
});

describe('rejectReasonProblem', () => {
  it('follows the server rule: 3 to 500 characters after trimming', () => {
    expect(rejectReasonProblem(' No ')).not.toBeNull();
    expect(rejectReasonProblem('Not legible')).toBeNull();
    expect(rejectReasonProblem('x'.repeat(501))).not.toBeNull();
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

  it('approves or rejects the prescription on the order (Work 132)', async () => {
    const request = vi.fn().mockResolvedValue({});
    const service = createPharmacyOrdersService(request as unknown as SessionRequest);

    await service.approvePrescription('f-1', { legibilityOk: true, validityOk: true });
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders/f-1/prescription/approve', { method: 'POST', body: { legibilityOk: true, validityOk: true } });
    await service.rejectPrescription('f-1', '  Not legible ');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders/f-1/prescription/reject', { method: 'POST', body: { reason: 'Not legible' } });
    await service.verifyPaper('f-1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders/f-1/paper-prescription/verify', { method: 'POST' });
    await service.rejectPaper('f-1', ' Another patient ');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/orders/f-1/paper-prescription/reject', { method: 'POST', body: { reason: 'Another patient' } });
  });

  it('offers no other operation', () => {
    const service = createPharmacyOrdersService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(service).sort()).toEqual(['accept', 'approvePrescription', 'decline', 'get', 'list', 'prepare', 'ready', 'rejectPaper', 'rejectPrescription', 'verifyPaper']);
  });
});
