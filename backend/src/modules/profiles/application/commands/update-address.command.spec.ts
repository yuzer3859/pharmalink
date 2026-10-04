import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Address } from '../../domain/entities/address.entity';
import { IAddressRepository } from '../../domain/repositories/address.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { DEFAULT_ADDRESS_INDEX } from '../support/default-address-conflict';
import { UpdateAddressCommand } from './update-address.command';

const ADDIS_ABABA = { lat: 9.03, lng: 38.74 };

/** A Prisma-shaped P2002 unique-constraint violation on the default-address partial index. */
function uniqueViolation(): Error & { code: string; meta: { target: string } } {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: DEFAULT_ADDRESS_INDEX },
  });
}

function fakeAddress(overrides: { userId?: string; isDefault?: boolean } = {}) {
  const address = Address.create('addr-1', overrides.userId ?? 'user-1', {
    recipientName: 'Abebe Kebede',
    recipientPhone: '+251912345678',
    city: 'Addis Ababa',
    region: 'Addis Ababa',
    lat: ADDIS_ABABA.lat,
    lng: ADDIS_ABABA.lng,
  });
  if (overrides.isDefault) {
    address.markDefault();
  }
  return address;
}

function build(address: Address | null) {
  const addresses: jest.Mocked<IAddressRepository> = {
    findById: jest.fn().mockResolvedValue(address),
    listByUserId: jest.fn(),
    countByUserId: jest.fn(),
    create: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    clearDefaultForUser: jest.fn().mockResolvedValue(null),
    findMostRecentlyUpdatedForUser: jest.fn(),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new UpdateAddressCommand(addresses, uow, audit, outbox);
  return { command, addresses, audit, outbox };
}

describe('UpdateAddressCommand', () => {
  it('rejects an empty edit set', async () => {
    const { command } = build(fakeAddress());
    await expect(command.execute({ userId: 'user-1', addressId: 'addr-1' })).rejects.toMatchObject(
      { code: 'VALIDATION_ERROR' },
    );
  });

  it('returns NOT_FOUND when the address belongs to another user', async () => {
    const { command } = build(fakeAddress({ userId: 'other-user' }));
    await expect(
      command.execute({ userId: 'user-1', addressId: 'addr-1', landmark: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects isDefault: false on the currently-default address', async () => {
    const { command } = build(fakeAddress({ isDefault: true }));
    await expect(
      command.execute({ userId: 'user-1', addressId: 'addr-1', isDefault: false }),
    ).rejects.toMatchObject({ code: 'DEFAULT_ADDRESS_REQUIRED' });
  });

  it('sets a non-default address as default atomically', async () => {
    const { command, addresses } = build(fakeAddress({ isDefault: false }));
    const result = await command.execute({ userId: 'user-1', addressId: 'addr-1', isDefault: true });
    expect(result.isDefault).toBe(true);
    expect(addresses.clearDefaultForUser).toHaveBeenCalledWith('user-1', undefined);
  });

  it('updates a simple field and returns the change', async () => {
    const { command } = build(fakeAddress());
    const result = await command.execute({
      userId: 'user-1',
      addressId: 'addr-1',
      landmark: 'Near the school',
    });
    expect(result.landmark).toBe('Near the school');
  });

  // -------------------------------------------------------------------------------------------
  // DEFECT-PROFILES-001 — PATCH { isDefault: true } performs the same default swap and races the
  // same way; the partial unique index (module-02 §6.3) must drive a retry, never a 500.
  // Each attempt re-reads via findById, so the mock returns a FRESH (rolled-back, non-default)
  // entity per call — mirroring a real transactional re-read.
  // -------------------------------------------------------------------------------------------
  function buildWithFreshReads() {
    const addresses: jest.Mocked<IAddressRepository> = {
      findById: jest.fn().mockImplementation(async () => fakeAddress({ isDefault: false })),
      listByUserId: jest.fn(),
      countByUserId: jest.fn(),
      create: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      clearDefaultForUser: jest.fn().mockResolvedValue('previous-default-id'),
      findMostRecentlyUpdatedForUser: jest.fn(),
    };
    const uow: IUnitOfWork = { run: (work) => work(undefined) };
    const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
    const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;
    return { command: new UpdateAddressCommand(addresses, uow, audit, outbox), addresses, audit, outbox };
  }

  it('retries the default swap when the partial unique index rejects a losing commit', async () => {
    const { command, addresses } = buildWithFreshReads();
    (addresses.save as jest.Mock)
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce(undefined);

    const result = await command.execute({ userId: 'user-1', addressId: 'addr-1', isDefault: true });

    expect(result.isDefault).toBe(true);
    expect(addresses.findById).toHaveBeenCalledTimes(2); // re-read on retry
    expect(addresses.save).toHaveBeenCalledTimes(2);
  });

  it('records audit + emits the default-changed event once, after the retry succeeds', async () => {
    const { command, audit, outbox, addresses } = buildWithFreshReads();
    (addresses.save as jest.Mock)
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce(undefined);

    await command.execute({ userId: 'user-1', addressId: 'addr-1', isDefault: true });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('gives up with a defined CONFLICT (never a 500) if contention never resolves', async () => {
    const { command, addresses } = buildWithFreshReads();
    (addresses.save as jest.Mock).mockRejectedValue(uniqueViolation());
    await expect(
      command.execute({ userId: 'user-1', addressId: 'addr-1', isDefault: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rethrows a non-conflict error unchanged (no retry)', async () => {
    const { command, addresses } = buildWithFreshReads();
    const boom = new Error('deadlock detected');
    (addresses.save as jest.Mock).mockRejectedValue(boom);
    await expect(
      command.execute({ userId: 'user-1', addressId: 'addr-1', isDefault: true }),
    ).rejects.toBe(boom);
    expect(addresses.save).toHaveBeenCalledTimes(1);
  });
});
