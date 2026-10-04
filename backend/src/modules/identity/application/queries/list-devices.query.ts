import { Inject, Injectable } from '@nestjs/common';
import { DEVICE_REPOSITORY, IDeviceRepository } from '../../domain/repositories/auth.repositories';
import { DevicePlatform } from '../../domain/enums';

export interface DeviceView {
  deviceId: string;
  name: string | null;
  platform: DevicePlatform;
  isTrusted: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** GET /auth/devices (module-01 §3.5 F-DEV-02, §11.4). */
@Injectable()
export class ListDevicesQuery {
  constructor(@Inject(DEVICE_REPOSITORY) private readonly devices: IDeviceRepository) {}

  async execute(userId: string): Promise<DeviceView[]> {
    const records = await this.devices.listForUser(userId);
    return records.map((r) => ({
      deviceId: r.id,
      name: r.name,
      platform: r.platform,
      isTrusted: r.isTrusted,
      lastLoginAt: r.lastLoginAt,
      createdAt: r.createdAt,
    }));
  }
}
