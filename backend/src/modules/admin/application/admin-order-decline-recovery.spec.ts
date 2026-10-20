import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { AdminOrderDeclineRecoveryController } from '../interface/controllers/admin-order-decline-recovery.controller';
import { ListOrderDeclineRecoveryQueryDto } from '../interface/dtos/order-decline-recovery.dto';
import { toOrderDeclineRecoveryListResponse } from '../interface/dtos/order-decline-recovery.response';
import { ListOrderDeclineRecoveryQuery, MAX_DECLINE_RECOVERY_PAGE_SIZE } from './queries/order-decline-recovery.queries';

describe('Admin pharmacy-decline recovery view (Work 55)', () => {
  it('paging defaults/clamps and forwards the state', async () => {
    const list = jest.fn().mockResolvedValue({});
    const q = new ListOrderDeclineRecoveryQuery({ list });
    await q.execute({});
    await q.execute({ state: 'ORPHANED', page: 2, size: 999 });
    expect(list.mock.calls).toEqual([[{ state: undefined }, 1, 20], [{ state: 'ORPHANED' }, 2, MAX_DECLINE_RECOVERY_PAGE_SIZE]]);
  });

  it('validation: the four states only, bounded paging, nothing else', () => {
    const errors = (plain: object) =>
      validateSync(plainToInstance(ListOrderDeclineRecoveryQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property).sort();
    expect(errors({ state: 'PENDING_CONFIRMATION', page: '1', size: '100' })).toEqual([]);
    expect(errors({ state: 'DONE', page: '0', size: '101' })).toEqual(['page', 'size', 'state']);
    expect(errors({ customerUserId: 'x' })).toEqual(['customerUserId']);
  });

  it('explicit allow-list: ids, statuses, timestamps and a diagnostic code only', () => {
    const d = new Date(0);
    const leaky = {
      orderId: 'o', orderStatus: 'PAID', lineId: 'l', fulfillmentId: 'f', fulfillmentStatus: 'PENDING', fulfillmentCreatedAt: d,
      reservationId: 'r', listingId: 'lst', reservationStatus: 'HELD', reservationExpiresAt: d, state: 'PENDING_CONFIRMATION', diagnosticCode: 'REPLACEMENT_HELD',
      customerUserId: 'cust', cancelReason: 'secret', leaseOwner: 'x',
    };
    const res = toOrderDeclineRecoveryListResponse({ generatedAt: d, countsScope: 'CURRENT_PAGE', pageCounts: { PENDING_CONFIRMATION: 1, CONFIRMATION_FAILED: 0, ORPHANED: 0, RESOLVED: 0 }, items: [leaky as never], totalOrders: 1, page: 1, size: 20 });
    expect(Object.keys(res.items[0])).toEqual([
      'orderId', 'orderStatus', 'lineId', 'fulfillmentId', 'fulfillmentStatus', 'fulfillmentCreatedAt',
      'reservationId', 'listingId', 'reservationStatus', 'reservationExpiresAt', 'state', 'diagnosticCode',
    ]);
    expect(JSON.stringify(res)).not.toMatch(/cust|secret|leaseOwner/);
    expect(Object.keys(res)).toEqual(['generatedAt', 'pageCounts', 'countsScope', 'items', 'totalOrders', 'page', 'size']);
    expect(res).not.toHaveProperty('counts'); // never a page-local count under a global-sounding name
  });

  it('order:read:any, GET-only, its own prefix', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOrderDeclineRecoveryController)).toEqual(['order:read:any']);
    expect(Reflect.getMetadata('path', AdminOrderDeclineRecoveryController)).toBe('admin/operations/order-decline-recovery');
    expect(Object.getOwnPropertyNames(AdminOrderDeclineRecoveryController.prototype).filter((m) => m !== 'constructor')).toEqual(['search']);
  });
});
