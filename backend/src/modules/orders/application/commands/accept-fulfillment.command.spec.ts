import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { IFulfillmentRepository } from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository } from '../../domain/repositories/order.repository';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { AcceptFulfillmentCommand } from './accept-fulfillment.command';
import { fulfillmentSnapshot, orderSnapshot } from './test-fixtures';

function build() {
  const fulfillment = fulfillmentSnapshot({ status: 'PENDING' });
  const order = orderSnapshot({ status: 'PAID' });
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
    findLinesByOrderId: jest.fn(),
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
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new AcceptFulfillmentCommand(fulfillments, orders, identity, pharmacies, uow, audit, outbox);
  return { command, fulfillments, orders, identity, pharmacies, audit, outbox, fulfillment, order };
}

function input(overrides: Record<string, unknown> = {}) {
  return { fulfillmentId: 'fulfillment-1', actorUserId: 'pharmacist-1', ...overrides };
}

describe('AcceptFulfillmentCommand', () => {
  it('accepts a PENDING fulfillment and cascades Order PAID -> ACCEPTED', async () => {
    const { command, fulfillments, orders, audit, outbox } = build();

    await command.execute(input());

    expect(fulfillments.updateStatus).toHaveBeenCalledWith(
      'fulfillment-1',
      expect.objectContaining({ status: 'ACCEPTED' }),
      undefined,
    );
    expect(orders.updateStatus).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ status: 'ACCEPTED' }),
      expect.objectContaining({ toStatus: 'ACCEPTED', event: 'ORDER_ACCEPTED' }),
      undefined,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORDER_ACCEPTED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('404s when the fulfillment does not exist', async () => {
    const { command, fulfillments } = build();
    fulfillments.findById.mockResolvedValue(null);

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404s (no existence leakage) when the actor does not hold a fulfillment role at this pharmacy', async () => {
    const { command, identity } = build();
    identity.hasRoleAtOrganization.mockResolvedValue(false);

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('409s (INVALID_ORDER_STATE_TRANSITION) when the fulfillment is not PENDING', async () => {
    const { command, fulfillments, fulfillment } = build();
    fulfillments.findById.mockResolvedValue({ ...fulfillment, status: 'ACCEPTED' });

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'INVALID_ORDER_STATE_TRANSITION',
    });
  });

  it('409s (INVALID_ORDER_STATE_TRANSITION) when the order is not PAID', async () => {
    const { command, orders, order } = build();
    orders.findById.mockResolvedValue({ ...order, status: 'ACCEPTED' });

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'INVALID_ORDER_STATE_TRANSITION',
    });
  });
});
