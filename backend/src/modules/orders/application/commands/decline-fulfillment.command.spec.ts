import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { IMatchingPort } from '../../../prescription-matching/application/ports/inbound/matching.port';
import { IInventoryPort } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { IFulfillmentRepository } from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository } from '../../domain/repositories/order.repository';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { DeclineFulfillmentCommand } from './decline-fulfillment.command';
import { fulfillmentSnapshot, orderLineSnapshot, orderSnapshot } from './test-fixtures';

function build() {
  const declinedFulfillment = fulfillmentSnapshot({ status: 'PENDING' });
  const order = orderSnapshot({ status: 'PAID', matchRequestId: 'match-1' });
  const line = orderLineSnapshot({ fulfillmentId: 'fulfillment-1' });
  const newFulfillment = fulfillmentSnapshot({ id: 'fulfillment-2', pharmacyId: 'pharmacy-2' });

  const fulfillments: jest.Mocked<IFulfillmentRepository> = {
    findById: jest.fn().mockResolvedValue(declinedFulfillment),
    findByOrderId: jest.fn(),
    create: jest.fn().mockResolvedValue(newFulfillment),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    listByPharmacyIds: jest.fn(),
  };
  const orders: jest.Mocked<IOrderRepository> = {
    findById: jest.fn().mockResolvedValue(order),
    findByOrderNumber: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    listByCustomer: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    findStatusHistory: jest.fn(),
    createLines: jest.fn(),
    findLinesByOrderId: jest.fn().mockResolvedValue([line]),
    updateLineFulfillment: jest.fn().mockResolvedValue(undefined),
    createInvoice: jest.fn(),
    findInvoiceByOrderId: jest.fn(),
  };
  const identity: jest.Mocked<IIdentityPort> = {
    getUserOrganizationIds: jest.fn(),
    hasRoleAtOrganization: jest.fn().mockResolvedValue(true),
  };
  // The fulfillment's pharmacy resolves to the organization the actor is checked against —
  // Fulfillment.pharmacyId is a Pharmacy.id, role grants are keyed by Organization.id.
  const pharmacies: jest.Mocked<IPharmacyPort> = {
    getOrganizationId: jest.fn().mockResolvedValue('organization-1'),
    findPharmacyIdsByOrganizationIds: jest.fn().mockResolvedValue([]),
  };
  const matching: jest.Mocked<IMatchingPort> = {
    find: jest.fn(),
    select: jest.fn(),
    rematch: jest.fn().mockResolvedValue({
      id: 'match-1',
      status: 'MATCHED',
      chosenResult: {
        pharmacyId: 'pharmacy-2',
        branchId: 'branch-2',
        lines: [{ catalogProductId: line.catalogProductId, listingId: 'listing-2', reservationId: 'reservation-2', quantity: line.quantity }],
      },
    }),
  };
  const calls: string[] = [];
  const inventory: jest.Mocked<IInventoryPort> = {
    reserve: jest.fn(),
    confirm: jest.fn<Promise<void>, [{ reservationId: string }]>(async () => { calls.push('confirm'); }),
    release: jest.fn(),
    dispatch: jest.fn(),
    getReservationFulfillment: jest.fn(),
    releaseAllUnlessDispatched: jest.fn<Promise<void>, [{ reservationIds: string[]; reason?: string }]>(async () => { calls.push('release-replacements'); }),
  };
  const cancellations = { findByOrderId: jest.fn().mockResolvedValue(null) };
  orders.updateLineFulfillment.mockImplementation(async () => { calls.push('repoint'); });
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new DeclineFulfillmentCommand(
    fulfillments,
    orders,
    identity, pharmacies,
    matching,
    inventory,
    cancellations as never,
    uow,
    audit,
    outbox,
  );
  return { command, fulfillments, orders, identity, pharmacies, matching, inventory, cancellations, calls, audit, outbox, declinedFulfillment, order, line };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    fulfillmentId: 'fulfillment-1',
    actorUserId: 'pharmacist-1',
    reason: 'Out of stock',
    ...overrides,
  };
}

describe('DeclineFulfillmentCommand', () => {
  it('cancels the declined fulfillment and re-points order lines at the re-matched pharmacy', async () => {
    const { command, fulfillments, orders, matching, audit } = build();

    const result = await command.execute(input());

    expect(fulfillments.updateStatus).toHaveBeenCalledWith(
      'fulfillment-1',
      { status: 'CANCELLED' },
      undefined,
    );
    expect(matching.rematch).toHaveBeenCalledWith(
      expect.objectContaining({ matchRequestId: 'match-1', customerUserId: 'customer-1' }),
    );
    expect(fulfillments.create).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', pharmacyId: 'pharmacy-2', branchId: 'branch-2' }),
      undefined,
    );
    expect(orders.updateLineFulfillment).toHaveBeenCalledWith(
      'line-1',
      expect.objectContaining({
        fulfillmentId: 'fulfillment-2',
        pharmacyId: 'pharmacy-2',
        reservationId: 'reservation-2',
      }),
      undefined,
    );
    expect(orders.updateStatus).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FULFILLMENT_REMATCHED' }),
      undefined,
    );
    expect(result.orderCancelled).toBe(false);
    expect(result.newFulfillment?.id).toBe('fulfillment-2');
  });

  it('cancels the order when re-match exhausts every candidate (BRULE-19)', async () => {
    const { command, matching, orders, outbox } = build();
    matching.rematch.mockResolvedValue({ id: 'match-1', status: 'FAILED', chosenResult: null } as never);

    const result = await command.execute(input());

    expect(orders.updateStatus).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ status: 'CANCELLED', cancelReason: 'NO_PHARMACY_MATCH' }),
      expect.objectContaining({ toStatus: 'CANCELLED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
    expect(result.orderCancelled).toBe(true);
    expect(result.newFulfillment).toBeNull();
  });

  it('404s when the fulfillment does not exist', async () => {
    const { command, fulfillments } = build();
    fulfillments.findById.mockResolvedValue(null);

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404s (no existence leakage) when the actor is not scoped to this pharmacy', async () => {
    const { command, identity } = build();
    identity.hasRoleAtOrganization.mockResolvedValue(false);

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('409s (INVALID_ORDER_STATE_TRANSITION) when the fulfillment cannot be declined', async () => {
    const { command, fulfillments, declinedFulfillment } = build();
    fulfillments.findById.mockResolvedValue({ ...declinedFulfillment, status: 'READY' });

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'INVALID_ORDER_STATE_TRANSITION',
    });
  });

  it('rejects when the order has no matchRequestId to re-match against', async () => {
    const { command, orders, order } = build();
    orders.findById.mockResolvedValue({ ...order, matchRequestId: null });

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  describe('Work 55 — replacement reservations after a successful re-match', () => {
    it('confirms exactly the replacement reservation the order now references, after the lines are re-pointed', async () => {
      const { command, inventory, calls } = build();
      const result = await command.execute(input());
      expect(result.orderCancelled).toBe(false);
      expect(inventory.confirm).toHaveBeenCalledTimes(1);
      expect(inventory.confirm).toHaveBeenCalledWith({ reservationId: 'reservation-2' });
      expect(calls).toEqual(['repoint', 'confirm']);
      expect(inventory.releaseAllUnlessDispatched).not.toHaveBeenCalled();
    });

    it('an order cancelled before Phase 3: nothing re-pointed or confirmed; the replacement holds are released', async () => {
      const { command, orders, fulfillments, inventory, order } = build();
      orders.findById.mockReset().mockResolvedValueOnce(order).mockResolvedValue({ ...order, status: 'CANCELLED' });
      const result = await command.execute(input());
      expect(result).toMatchObject({ newFulfillment: null, orderCancelled: true });
      expect(fulfillments.create).not.toHaveBeenCalled();
      expect(orders.updateLineFulfillment).not.toHaveBeenCalled();
      expect(inventory.confirm).not.toHaveBeenCalled();
      expect(inventory.releaseAllUnlessDispatched).toHaveBeenCalledWith({ reservationIds: ['reservation-2'], reason: 'decline-order-cancelled' });
    });

    it('an open customer cancellation request (read in the same transaction) also stops Phase 3', async () => {
      const { command, cancellations, orders, inventory } = build();
      cancellations.findByOrderId.mockResolvedValue({ phase: 'STOCK_RELEASED' });
      const result = await command.execute(input());
      expect(result.orderCancelled).toBe(true);
      expect(orders.updateLineFulfillment).not.toHaveBeenCalled();
      expect(inventory.confirm).not.toHaveBeenCalled();
      expect(cancellations.findByOrderId).toHaveBeenCalledWith('order-1', undefined);
    });

    it('a REJECTED cancellation request (dispatch won) does not block the re-match', async () => {
      const { command, cancellations, inventory } = build();
      cancellations.findByOrderId.mockResolvedValue({ phase: 'REJECTED' });
      expect((await command.execute(input())).orderCancelled).toBe(false);
      expect(inventory.confirm).toHaveBeenCalledTimes(1);
    });

    it('a replacement already released by a concurrent cancellation (order now CANCELLED) is not an error', async () => {
      const { command, inventory, orders, order } = build();
      inventory.confirm.mockRejectedValueOnce(new ApiException(ErrorCode.INVALID_RESERVATION_STATE, 'released'));
      orders.findById.mockResolvedValueOnce(order).mockResolvedValueOnce(order).mockResolvedValue({ ...order, status: 'CANCELLED' });
      await expect(command.execute(input())).resolves.toMatchObject({ orderCancelled: false });
    });

    it('transient confirm failures are retried; a permanent one is surfaced, never swallowed', async () => {
      const retried = build();
      retried.inventory.confirm
        .mockRejectedValueOnce(Object.assign(new Error('pool timeout'), { code: 'P2024' }))
        .mockResolvedValueOnce(undefined);
      await retried.command.execute(input());
      expect(retried.inventory.confirm).toHaveBeenCalledTimes(2);

      const failing = build();
      failing.inventory.confirm.mockRejectedValue(new ApiException(ErrorCode.RESERVATION_EXPIRED, 'expired'));
      await expect(failing.command.execute(input())).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
      expect(failing.inventory.confirm).toHaveBeenCalledTimes(1);
    });

    it('an exhausted re-match (FAILED) neither confirms nor releases anything here (unchanged)', async () => {
      const { command, matching, inventory } = build();
      matching.rematch.mockResolvedValue({ id: 'match-1', status: 'FAILED', chosenResult: null } as never);
      expect((await command.execute(input())).orderCancelled).toBe(true);
      expect(inventory.confirm).not.toHaveBeenCalled();
      expect(inventory.releaseAllUnlessDispatched).not.toHaveBeenCalled();
    });
  });
});
