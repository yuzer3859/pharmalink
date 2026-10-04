import { AuditService } from '../../../../shared/audit/audit.service';
import { IDispensingPort } from '../../../prescription-matching/application/ports/inbound/dispensing.port';
import { IFulfillmentRepository } from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository } from '../../domain/repositories/order.repository';
import { IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { PrepareFulfillmentCommand } from './prepare-fulfillment.command';
import { fulfillmentSnapshot, orderLineSnapshot } from './test-fixtures';

function build() {
  const fulfillment = fulfillmentSnapshot({ status: 'ACCEPTED' });
  const fulfillments: jest.Mocked<IFulfillmentRepository> = {
    findById: jest.fn().mockResolvedValue(fulfillment),
    findByOrderId: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    listByPharmacyIds: jest.fn(),
  };
  const orders: jest.Mocked<IOrderRepository> = {
    findById: jest.fn(),
    findByOrderNumber: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    listByCustomer: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    findStatusHistory: jest.fn(),
    createLines: jest.fn(),
    findLinesByOrderId: jest.fn().mockResolvedValue([
      orderLineSnapshot({ id: 'line-1', requiresRx: true, prescriptionLineId: 'rx-line-1' }),
      orderLineSnapshot({ id: 'line-2', requiresRx: false, prescriptionLineId: null }),
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
  const dispensing: jest.Mocked<IDispensingPort> = {
    dispense: jest.fn().mockResolvedValue({ dispenseRecordId: 'dispense-1' }),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;

  const command = new PrepareFulfillmentCommand(
    fulfillments,
    orders,
    identity, pharmacies,
    dispensing,
    uow,
    audit,
  );
  return { command, fulfillments, orders, identity, pharmacies, dispensing, audit, fulfillment };
}

function input(overrides: Record<string, unknown> = {}) {
  return { fulfillmentId: 'fulfillment-1', actorUserId: 'pharmacist-1', ...overrides };
}

describe('PrepareFulfillmentCommand', () => {
  it('dispenses every Rx line on the fulfillment and transitions ACCEPTED -> PREPARING', async () => {
    const { command, dispensing, fulfillments, audit } = build();

    await command.execute(input());

    expect(dispensing.dispense).toHaveBeenCalledTimes(1);
    expect(dispensing.dispense).toHaveBeenCalledWith(
      expect.objectContaining({
        prescriptionLineId: 'rx-line-1',
        orderId: 'order-1',
        pharmacyId: 'pharmacy-1',
        dispensedByUserId: 'pharmacist-1',
      }),
    );
    expect(fulfillments.updateStatus).toHaveBeenCalledWith(
      'fulfillment-1',
      { status: 'PREPARING' },
      undefined,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FULFILLMENT_PREPARING' }),
      undefined,
    );
  });

  it('does not call the dispensing port for non-Rx lines', async () => {
    const { command, dispensing, orders } = build();
    orders.findLinesByOrderId.mockResolvedValue([
      orderLineSnapshot({ id: 'line-2', requiresRx: false, prescriptionLineId: null }),
    ]);

    await command.execute(input());

    expect(dispensing.dispense).not.toHaveBeenCalled();
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

  it('409s (INVALID_ORDER_STATE_TRANSITION) when the fulfillment is not ACCEPTED', async () => {
    const { command, fulfillments, fulfillment } = build();
    fulfillments.findById.mockResolvedValue({ ...fulfillment, status: 'PENDING' });

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'INVALID_ORDER_STATE_TRANSITION',
    });
  });
});
