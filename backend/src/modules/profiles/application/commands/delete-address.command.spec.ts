import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Address } from '../../domain/entities/address.entity';
import { IAddressRepository } from '../../domain/repositories/address.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { DeleteAddressCommand } from './delete-address.command';

const ADDIS_ABABA = { lat: 9.03, lng: 38.74 };

function fakeAddress(id: string, isDefault = false) {
  const address = Address.create(id, 'user-1', {
    recipientName: 'Abebe Kebede',
    recipientPhone: '+251912345678',
    city: 'Addis Ababa',
    region: 'Addis Ababa',
    lat: ADDIS_ABABA.lat,
    lng: ADDIS_ABABA.lng,
  });
  if (isDefault) address.markDefault();
  return address;
}

function build(target: Address | null, replacement: Address | null = null) {
  const addresses: jest.Mocked<IAddressRepository> = {
    findById: jest.fn().mockResolvedValue(target),
    listByUserId: jest.fn(),
    countByUserId: jest.fn(),
    create: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    clearDefaultForUser: jest.fn(),
    findMostRecentlyUpdatedForUser: jest.fn().mockResolvedValue(replacement),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new DeleteAddressCommand(addresses, uow, audit, outbox);
  return { command, addresses, audit, outbox };
}

describe('DeleteAddressCommand', () => {
  it('returns NOT_FOUND for an address owned by another user', async () => {
    const other = fakeAddress('addr-1');
    Object.defineProperty(other, 'userId', { get: () => 'other-user' });
    const { command } = build(other);
    await expect(command.execute({ userId: 'user-1', addressId: 'addr-1' })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('soft-deletes a non-default address without promoting anything', async () => {
    const target = fakeAddress('addr-1', false);
    const { command, addresses, outbox } = build(target);
    await command.execute({ userId: 'user-1', addressId: 'addr-1' });
    expect(addresses.save).toHaveBeenCalledTimes(1);
    expect(target.deletedAt).not.toBeNull();
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('promotes the most-recently-updated remaining address when deleting the default', async () => {
    const target = fakeAddress('addr-1', true);
    const replacement = fakeAddress('addr-2', false);
    const { command, addresses, outbox } = build(target, replacement);
    await command.execute({ userId: 'user-1', addressId: 'addr-1' });
    expect(replacement.isDefault).toBe(true);
    expect(addresses.save).toHaveBeenCalledTimes(2);
    expect(outbox.write).toHaveBeenCalledTimes(2);
  });

  it('leaves the user with zero addresses when deleting their only address', async () => {
    const target = fakeAddress('addr-1', true);
    const { command, addresses } = build(target, null);
    await command.execute({ userId: 'user-1', addressId: 'addr-1' });
    expect(addresses.save).toHaveBeenCalledTimes(1);
  });
});
