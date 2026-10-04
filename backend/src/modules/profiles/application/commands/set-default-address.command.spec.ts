import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Address } from '../../domain/entities/address.entity';
import { IAddressRepository } from '../../domain/repositories/address.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { DEFAULT_ADDRESS_INDEX } from '../support/default-address-conflict';
import { SetDefaultAddressCommand } from './set-default-address.command';

const ADDIS_ABABA = { lat: 9.03, lng: 38.74 };

/** A Prisma-shaped P2002 unique-constraint violation on the default-address partial index. */
function uniqueViolation(): Error & { code: string; meta: { target: string } } {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: DEFAULT_ADDRESS_INDEX },
  });
}

/** Builds a fresh, non-default address so each transactional re-read reflects rolled-back state. */
function nonDefaultAddress(userId = 'user-1', id = 'addr-1'): Address {
  return Address.create(id, userId, {
    recipientName: 'Abebe Kebede',
    recipientPhone: '+251912345678',
    city: 'Addis Ababa',
    region: 'Addis Ababa',
    lat: ADDIS_ABABA.lat,
    lng: ADDIS_ABABA.lng,
  });
}

function build(findByIdImpl: () => Address | null) {
  const addresses: jest.Mocked<IAddressRepository> = {
    findById: jest.fn().mockImplementation(async () => findByIdImpl()),
    listByUserId: jest.fn(),
    countByUserId: jest.fn(),
    create: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    clearDefaultForUser: jest.fn().mockResolvedValue('previous-default-id'),
    findMostRecentlyUpdatedForUser: jest.fn(),
  };
  // Real transaction semantics: run the closure; a thrown error propagates to the caller
  // (mirrors prisma.$transaction rolling back and rethrowing).
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new SetDefaultAddressCommand(addresses, uow, audit, outbox);
  return { command, addresses, audit, outbox };
}

describe('SetDefaultAddressCommand', () => {
  it('swaps the default atomically for a non-default address', async () => {
    const { command, addresses } = build(() => nonDefaultAddress());
    const result = await command.execute({ userId: 'user-1', addressId: 'addr-1' });
    expect(result.isDefault).toBe(true);
    expect(addresses.clearDefaultForUser).toHaveBeenCalledWith('user-1', undefined);
    expect(addresses.save).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the address is already the default', async () => {
    const alreadyDefault = nonDefaultAddress();
    alreadyDefault.markDefault();
    const { command, addresses } = build(() => alreadyDefault);
    const result = await command.execute({ userId: 'user-1', addressId: 'addr-1' });
    expect(result.isDefault).toBe(true);
    expect(addresses.clearDefaultForUser).not.toHaveBeenCalled();
    expect(addresses.save).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the address belongs to another user', async () => {
    const { command } = build(() => nonDefaultAddress('other-user'));
    await expect(
      command.execute({ userId: 'user-1', addressId: 'addr-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------------------------
  // DEFECT-PROFILES-001 — the concurrent default-address race (module-02 §6.3, edge case 8).
  // -------------------------------------------------------------------------------------------
  it('retries against re-read state when the partial unique index rejects a losing commit, ' +
    'instead of surfacing a 500', async () => {
    // The concurrent winner commits between our read and our write, so the first save loses the
    // race with a P2002; on retry the (fresh, rolled-back) re-read succeeds.
    const { command, addresses } = build(() => nonDefaultAddress());
    (addresses.save as jest.Mock)
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce(undefined);

    const result = await command.execute({ userId: 'user-1', addressId: 'addr-1' });

    expect(result.isDefault).toBe(true);
    expect(addresses.findById).toHaveBeenCalledTimes(2); // re-read on retry
    expect(addresses.save).toHaveBeenCalledTimes(2);
  });

  it('records the audit entry and emits the event exactly once, after the retry succeeds', async () => {
    const { command, addresses, audit, outbox } = build(() => nonDefaultAddress());
    (addresses.save as jest.Mock)
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce(undefined);

    await command.execute({ userId: 'user-1', addressId: 'addr-1' });

    // Audit/outbox happen once, after the transaction finally commits — never per failed attempt.
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('gives up with a defined CONFLICT (never a 500) if contention never resolves', async () => {
    const { command, addresses } = build(() => nonDefaultAddress());
    (addresses.save as jest.Mock).mockRejectedValue(uniqueViolation());

    await expect(
      command.execute({ userId: 'user-1', addressId: 'addr-1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rethrows a non-conflict error unchanged (does not retry unrelated failures)', async () => {
    const { command, addresses } = build(() => nonDefaultAddress());
    const boom = new Error('connection reset');
    (addresses.save as jest.Mock).mockRejectedValue(boom);

    await expect(command.execute({ userId: 'user-1', addressId: 'addr-1' })).rejects.toBe(boom);
    expect(addresses.save).toHaveBeenCalledTimes(1); // no retry
  });
});
