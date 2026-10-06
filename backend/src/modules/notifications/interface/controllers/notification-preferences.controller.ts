import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { UpdateNotificationPreferencesCommand } from '../../application/commands/update-notification-preferences.command';
import { GetNotificationPreferencesQuery } from '../../application/queries/get-notification-preferences.query';
import {
  NotificationPreferenceCategoryParamDto,
  UpdateNotificationPreferencesDto,
} from '../dtos/notification-preference.dto';
import {
  CategoryPreferencesResponse,
  NotificationPreferencesResponse,
  toCategoryPreferencesResponse,
} from '../dtos/notification-preference.response';

/**
 * The caller's own notification preferences (module-13 Work 11).
 *
 *     GET /notification-preferences              — every configurable category
 *     GET /notification-preferences/:category    — TRANSACTIONAL | SECURITY | SYSTEM
 *     PUT /notification-preferences/:category    — { channels: [{ channel, enabled, digestFrequency? }] }
 *
 * ## Own data only, structurally
 *
 * The owner is always `@CurrentUser()`; no route takes a user id, and the body rejects one
 * (`forbidNonWhitelisted`). There is therefore no way to name another user's preferences.
 *
 * ## Authorization
 *
 * Reads take `notification:read:own`, the notification center's key. The write takes
 * `notification:manage:own` — added by this work following the catalogue's `*:manage:own`
 * convention (`address:manage:own`), granted to exactly the roles holding `notification:read:own`,
 * and attached to nothing but this route.
 *
 * ## Audit
 *
 * None, for reads or writes: see `UpdateNotificationPreferencesCommand`.
 */
@Controller('notification-preferences')
export class NotificationPreferencesController {
  constructor(
    private readonly preferences: GetNotificationPreferencesQuery,
    private readonly update: UpdateNotificationPreferencesCommand,
  ) {}

  @Get()
  @RequirePermissions('notification:read:own')
  async list(@CurrentUser() user: AuthenticatedPrincipal): Promise<NotificationPreferencesResponse> {
    return { categories: (await this.preferences.all(user.userId)).map(toCategoryPreferencesResponse) };
  }

  @Get(':category')
  @RequirePermissions('notification:read:own')
  async get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param() params: NotificationPreferenceCategoryParamDto,
  ): Promise<CategoryPreferencesResponse> {
    return toCategoryPreferencesResponse(await this.preferences.forCategory(user.userId, params.category));
  }

  @Put(':category')
  @RequirePermissions('notification:manage:own')
  async put(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param() params: NotificationPreferenceCategoryParamDto,
    @Body() body: UpdateNotificationPreferencesDto,
  ): Promise<CategoryPreferencesResponse> {
    return toCategoryPreferencesResponse(
      await this.update.execute({ userId: user.userId, category: params.category, channels: body.channels }),
    );
  }
}
