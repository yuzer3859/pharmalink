import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { IAddressRepository } from '../../domain/repositories/address.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { DEFAULT_ADDRESS_INDEX } from '../support/default-address-conflict';
import { CreateAddressCommand } from './create-address.command';

const ADDIS_ABABA = { lat: 9.03, lng: 38.74 };
const OUTSIDE_ETHIOPIA = { lat: -1.286389, lng: 36.817223 }; // Nairobi, Kenya

/** A Prisma-shaped P2002 unique-constraint violation on the default-address partial index. */
function uniqueViolation(): Error & { code: string; meta: { target: string } } {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: DEFAULT_ADDRESS_INDEX },
  });
}

function build(existingCount = 0) {
  const addresses: jest.Mocked<IAddressRepository> = {
    findById: jest.fn(),
    listByUserId: jest.fn(),
    countByUserId: jest.fn().mockResolvedValue(existingCount),
    create: jest.fn().mockResolvedValue(undefined),
    save: jest.fn(),
    clearDefaultForUser: jest.fn().mockResolvedValue(null),
    findMostRecentlyUpdatedForUser: jest.fn(),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new CreateAddressCommand(addresses, uow, audit, outbox);
  return { command, addresses, audit, outbox };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    recipientName: 'Abebe Kebede',
    recipientPhone: '0912345678',
    city: 'Addis Ababa',
    region: 'Addis Ababa',
    lat: ADDIS_ABABA.lat,
    lng: ADDIS_ABABA.lng,
    ...overrides,
  };
}

describe('CreateAddressCommand', () => {
  it('marks the first address as default automatically', async () => {
    const { command, addresses } = build(0);
    const result = await command.execute(validInput());
    expect(result.isDefault).toBe(true);
    expect(addresses.create).toHaveBeenCalledTimes(1);
  });

  it('does not default a second address unless requested', async () => {
    const { command } = build(1);
    const result = await command.execute(validInput());
    expect(result.isDefault).toBe(false);
  });

  it('honors an explicit isDefault: true for a non-first address', async () => {
    const { command, addresses } = build(1);
    const result = await command.execute(validInput({ isDefault: true }));
    expect(result.isDefault).toBe(true);
    expect(addresses.clearDefaultForUser).toHaveBeenCalledWith('user-1', undefined);
  });

  it('rejects the 21st address with ADDRESS_LIMIT_REACHED', async () => {
    const { command } = build(20);
    await expect(command.execute(validInput())).rejects.toMatchObject({
      code: 'ADDRESS_LIMIT_REACHED',
    });
  });

  it('rejects coordinates outside Ethiopia', async () => {
    const { command } = build(0);
    await expect(
      command.execute(validInput({ lat: OUTSIDE_ETHIOPIA.lat, lng: OUTSIDE_ETHIOPIA.lng })),
    ).rejects.toMatchObject({ code: 'ADDRESS_OUTSIDE_ETHIOPIA' });
  });

  it('rejects a non-Ethiopian phone number', async () => {
    const { command } = build(0);
    await expect(
      command.execute(validInput({ recipientPhone: '+15551234567' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('writes an audit entry and an AddressAdded event', async () => {
    const { command, audit, outbox } = build(0);
    await command.execute(validInput());
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ADDRESS_ADDED', resourceType: 'Address' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------------------------
  // DEFECT-PROFILES-001 — a create that also becomes the default races concurrent default
  // changes; the partial unique index (module-02 §6.3) must trigger a retry, not a 500.
  // -------------------------------------------------------------------------------------------
  it('retries the insert when the default partial unique index rejects a losing commit', async () => {
    const { command, addresses } = build(0); // first address -> makeDefault path
    (addresses.create as jest.Mock)
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce(undefined);

    const result = await command.execute(validInput());

    expect(result.isDefault).toBe(true);
    expect(addresses.create).toHaveBeenCalledTimes(2);
    expect(addresses.countByUserId).toHaveBeenCalledTimes(2); // re-evaluated on retry
  });

  it('gives up with a defined CONFLICT (never a 500) if contention never resolves', async () => {
    const { command, addresses } = build(0);
    (addresses.create as jest.Mock).mockRejectedValue(uniqueViolation());
    await expect(command.execute(validInput({ isDefault: true }))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('rethrows a non-conflict persistence error unchanged (no retry)', async () => {
    const { command, addresses } = build(0);
    const boom = new Error('disk full');
    (addresses.create as jest.Mock).mockRejectedValue(boom);
    await expect(command.execute(validInput())).rejects.toBe(boom);
    expect(addresses.create).toHaveBeenCalledTimes(1);
  });
});
