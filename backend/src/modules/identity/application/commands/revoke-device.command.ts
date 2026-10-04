import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import { DEVICE_REPOSITORY, IDeviceRepository } from '../../domain/repositories/auth.repositories';

/**
 * DELETE /auth/devices/{id} (module-01 §3.5 F-DEV-02/F-DEV-04, §11.4). Ownership-checked; revokes
 * the device plus every session/refresh-token bound to it (handled transactionally by the
 * Prisma adapter).
 */
@Injectable()
export class RevokeDeviceCommand {
  constructor(@Inject(DEVICE_REPOSITORY) private readonly devices: IDeviceRepository) {}

  async execute(userId: string, deviceId: string): Promise<void> {
    const device = await this.devices.findById(deviceId);
    if (!device || device.userId !== userId) {
      throw ApiException.notFound('Device not found');
    }
    await this.devices.revoke(deviceId);
  }
}
