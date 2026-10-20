import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { AdminOrderCancellationOperationsController } from '../interface/controllers/admin-order-cancellation-operations.controller';
import { ListOrderCancellationOperationsQueryDto } from '../interface/dtos/order-cancellation-operations.dto';
import { toOrderCancellationOperationsListResponse } from '../interface/dtos/order-cancellation-operations.response';
import { ListOrderCancellationOperationsQuery, MAX_CANCELLATION_OPERATIONS_PAGE_SIZE } from './queries/order-cancellation-operations.queries';

describe('Admin open order cancellations (Work 55)', () => {
  it('paging defaults/clamps and forwards the state', async () => {
    const list = jest.fn().mockResolvedValue({});
    const q = new ListOrderCancellationOperationsQuery({ list });
    await q.execute({});
    await q.execute({ state: 'ATTENTION', page: 3, size: 500 });
    expect(list.mock.calls).toEqual([[{ state: undefined }, 1, 20], [{ state: 'ATTENTION' }, 3, MAX_CANCELLATION_OPERATIONS_PAGE_SIZE]]);
  });

  it('validation: PENDING|ATTENTION only, bounded paging, nothing else', () => {
    const errors = (plain: object) =>
      validateSync(plainToInstance(ListOrderCancellationOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property).sort();
    expect(errors({ state: 'ATTENTION', page: '1', size: '100' })).toEqual([]);
    expect(errors({ state: 'COMPLETED', page: '0', size: '101' })).toEqual(['page', 'size', 'state']);
    expect(errors({ customerUserId: 'x' })).toEqual(['customerUserId']);
  });

  it('explicit allow-list: no customer id, reason or lease ever reaches the response', () => {
    const d = new Date(0);
    const leaky = {
      requestId: 'r', orderId: 'o', state: 'ATTENTION', phase: 'REQUESTED', attempts: 1, lastErrorCode: 'LISTING_NOT_FOUND', lastErrorAt: d,
      nextAttemptAt: d, attentionRequiredAt: d, createdAt: d, updatedAt: d, customerUserId: 'cust', reason: 'secret', leaseOwner: 'l',
    };
    const res = toOrderCancellationOperationsListResponse({ generatedAt: d, counts: { pending: 0, attention: 1, extra: 9 } as never, items: [leaky as never], total: 1, page: 1, size: 20 });
    expect(Object.keys(res.items[0])).toEqual(['requestId', 'orderId', 'state', 'phase', 'attempts', 'lastErrorCode', 'lastErrorAt', 'nextAttemptAt', 'attentionRequiredAt', 'createdAt', 'updatedAt']);
    expect(res.counts).toEqual({ pending: 0, attention: 1 });
    expect(JSON.stringify(res)).not.toMatch(/cust|secret|leaseOwner/);
  });

  it('order:read:any (as Work 35), GET-only, its own prefix', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOrderCancellationOperationsController)).toEqual(['order:read:any']);
    expect(Reflect.getMetadata('path', AdminOrderCancellationOperationsController)).toBe('admin/operations/order-cancellations');
    expect(Object.getOwnPropertyNames(AdminOrderCancellationOperationsController.prototype).filter((m) => m !== 'constructor')).toEqual(['search']);
    const holders = Object.entries(ROLE_PERMISSIONS).filter(([, g]) => hasPermission(g, 'order:read:any')).map(([r]) => r).sort();
    expect(holders).not.toContain('CUSTOMER');
    expect(holders).not.toContain('PHARMACY_OWNER');
  });
});
