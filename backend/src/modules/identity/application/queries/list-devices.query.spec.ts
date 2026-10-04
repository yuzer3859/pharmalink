import { DevicePlatform } from '../../domain/enums';
import { DeviceRecord, IDeviceRepository } from '../../domain/repositories/auth.repositories';
import { ListDevicesQuery } from './list-devices.query';

function fakeDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: 'device-1',
    userId: 'user-1',
    fingerprint: 'fp-1',
    name: 'My Phone',
    platform: DevicePlatform.ANDROID,
    isTrusted: true,
    lastLoginAt: new Date(),
    createdAt: new Date(),
    revokedAt: null,
    ...overrides,
  };
}

describe('ListDevicesQuery', () => {
  it('maps device records to the API view', async () => {
    const devices = {
      listForUser: jest.fn().mockResolvedValue([fakeDevice()]),
    } as unknown as IDeviceRepository;

    const query = new ListDevicesQuery(devices);
    const result = await query.execute('user-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      deviceId: 'device-1',
      name: 'My Phone',
      platform: DevicePlatform.ANDROID,
      isTrusted: true,
      lastLoginAt: expect.any(Date),
      createdAt: expect.any(Date),
    });
  });
});
