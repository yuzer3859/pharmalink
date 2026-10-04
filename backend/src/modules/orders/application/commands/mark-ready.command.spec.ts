import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { IInventoryPort } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { IFulfillmentRepository } from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository } from '../../domain/repositories/order.repository';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { MarkReadyCommand } from './mark-ready.command';
import { fulfillmentSnapshot, orderLineSnapshot, orderSnapshot } from './test-fixtures';

function build() {
  const fulfillment = fulfillmentSnapshot({ status: 'PREPARING' });
  const order = orderSnapshot({ status: 'ACCEPTED' });
  const fulfillments: jest.Mocked<IFulfillmentRepository> = {
    findById: jest.fn().mockResolvedValue(fulfillment),
    findByOrderId: jest.fn(),
    create: jest.fn(),
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
    findLinesByOrderId: jest.fn().mockResolvedValue([
      orderLineSnapshot({ id: 'line-1', reservationId: 'reservation-1' }),
    ]),
    updateLineFulfillment: jest.fn(),
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
  const inventory: jest.Mocked<IInventoryPort> = {
    reserve: jest.fn(),
    confirm: jest.fn(),
    release: jest.fn(),
    dispatch: jest.fn().mockResolvedValue(undefined),
    getReservationFulfillment: jest.fn(),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new MarkReadyCommand(fulfillments, orders, identity, pharmacies, inventory, uow, audit, outbox);
  return { command, fulfillments, orders, identity, pharmacies, inventory, audit, outbox, fulfillment, order };
}

function input(overrides: Record<string, unknown> = {}) {
  return { fulfillmentId: 'fulfillment-1', actorUserId: 'pharmacist-1', ...overrides };
}

describe('MarkReadyCommand', () => {
  it('dispatches every reservation and transitions Fulfillment/Order to READY', async () => {
    const { command, inventory, fulfillments, orders, audit, outbox } = build();

    await command.execute(input());

    expect(inventory.dispatch).toHaveBeenCalledWith({
      reservationId: 'reservation-1',
      actorUserId: 'pharmacist-1',
    });
    expect(fulfillments.updateStatus).toHaveBeenCalledWith(
      'fulfillment-1',
      expect.objectContaining({ status: 'READY' }),
      undefined,
    );
    expect(orders.updateStatus).toHaveBeenCalledWith(
      'order-1',
      { status: 'READY' },
      expect.objectContaining({ toStatus: 'READY', event: 'ORDER_READY' }),
      undefined,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORDER_READY' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
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

  it('409s (INVALID_ORDER_STATE_TRANSITION) when the fulfillment is not PREPARING', async () => {
    const { command, fulfillments, fulfillment } = build();
    fulfillments.findById.mockResolvedValue({ ...fulfillment, status: 'ACCEPTED' });

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'INVALID_ORDER_STATE_TRANSITION',
    });
  });

  it('409s (INVALID_ORDER_STATE_TRANSITION) when the order is not ACCEPTED', async () => {
    const { command, orders, order } = build();
    orders.findById.mockResolvedValue({ ...order, status: 'PAID' });

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'INVALID_ORDER_STATE_TRANSITION',
    });
  });
});
