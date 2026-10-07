import { Inject, Injectable } from '@nestjs/common';
import { NotificationErrors } from '../../domain/errors';
import {
  DEVICE_TOKEN_REPOSITORY,
  DevicePlatform,
  DeviceTokenView,
  IDeviceTokenRepository,
} from '../../domain/repositories/device-token.repository';

/**
 * The caller's own push-device registrations (module-13 Work 14): register, list, revoke. The owner
 * is always the authenticated principal. Not audited — neither Module 01's device revocation nor
 * Work 11's preferences are — and no event is published.
 */
@Injectable()
export class ManageDeviceTokensCommand {
  constructor(@Inject(DEVICE_TOKEN_REPOSITORY) private readonly tokens: IDeviceTokenRepository) {}

  /** Idempotent: registering the same token again refreshes it rather than adding a row. */
  register(userId: string, token: string, platform: DevicePlatform): Promise<DeviceTokenView> {
    return this.tokens.register(userId, token, platform, new Date());
  }

  list(userId: string): Promise<DeviceTokenView[]> {
    return this.tokens.listActiveForUser(userId);
  }

  /** Deactivates the registration; another user's, or an unknown id, is `404`. */
  async revoke(userId: string, id: string): Promise<void> {
    if (!(await this.tokens.deactivateForUser(id, userId))) throw NotificationErrors.deviceNotFound();
  }
}
