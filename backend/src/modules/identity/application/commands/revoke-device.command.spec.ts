import { DevicePlatform } from '../../domain/enums';
import { DeviceRecord, IDeviceRepository } from '../../domain/repositories/auth.repositories';
import { RevokeDeviceCommand } from './revoke-device.command';

function fakeDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: 'device-1',
    userId: 'user-1',
    fingerprint: 'fp-1',
    name: null,
    platform: DevicePlatform.ANDROID,
    isTrusted: false,
    lastLoginAt: null,
    createdAt: new Date(),
    revokedAt: null,
    ...overrides,
  };
}

describe('RevokeDeviceCommand', () => {
  it('revokes a device owned by the requesting user', async () => {
    const devices = {
      findById: jest.fn().mockResolvedValue(fakeDevice()),
      revoke: jest.fn(),
    } as unknown as IDeviceRepository;

    const command = new RevokeDeviceCommand(devices);
    await command.execute('user-1', 'device-1');

    expect(devices.revoke).toHaveBeenCalledWith('device-1');
  });

  it('rejects revoking a device owned by someone else', async () => {
    const devices = {
      findById: jest.fn().mockResolvedValue(fakeDevice({ userId: 'someone-else' })),
      revoke: jest.fn(),
    } as unknown as IDeviceRepository;

    const command = new RevokeDeviceCommand(devices);
    await expect(command.execute('user-1', 'device-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(devices.revoke).not.toHaveBeenCalled();
  });
});
