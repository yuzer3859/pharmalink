import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ManageDeviceTokensCommand } from '../../application/commands/manage-device-tokens.command';
import { RegisterDeviceTokenDto } from '../dtos/notification-device.dto';
import { NotificationDeviceResponse, toNotificationDeviceResponse } from '../dtos/notification-device.response';

/**
 * The caller's own push devices (module-13 Work 14).
 *
 *     POST   /notification-devices        { token, platform } — register (idempotent per token)
 *     GET    /notification-devices        — active registrations, raw tokens masked
 *     DELETE /notification-devices/:id    — revoke; another user's or unknown → 404
 *
 * Distinct from Module 01's `/auth/devices` (login devices and sessions). The owner is always
 * `@CurrentUser()`. Reads take `notification:read:own`; register and revoke take
 * `notification:manage:own` — the catalogue's own-scope key for a user's notification settings
 * (Work 11), reused rather than minting a device-specific one. Nothing is audited.
 */
@Controller('notification-devices')
export class NotificationDevicesController {
  constructor(private readonly devices: ManageDeviceTokensCommand) {}

  @Post()
  @RequirePermissions('notification:manage:own')
  async register(@CurrentUser() user: AuthenticatedPrincipal, @Body() body: RegisterDeviceTokenDto): Promise<NotificationDeviceResponse> {
    return toNotificationDeviceResponse(await this.devices.register(user.userId, body.token, body.platform));
  }

  @Get()
  @RequirePermissions('notification:read:own')
  async list(@CurrentUser() user: AuthenticatedPrincipal): Promise<{ items: NotificationDeviceResponse[] }> {
    return { items: (await this.devices.list(user.userId)).map(toNotificationDeviceResponse) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('notification:manage:own')
  async revoke(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.devices.revoke(user.userId, id);
  }
}
