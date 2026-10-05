import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { MarkAllNotificationsReadCommand } from '../../application/commands/mark-all-notifications-read.command';
import { MarkNotificationReadCommand } from '../../application/commands/mark-notification-read.command';
import { GetUnreadCountQuery } from '../../application/queries/get-unread-count.query';
import { ListNotificationsQuery } from '../../application/queries/list-notifications.query';
import { ListNotificationsQueryDto } from '../dtos/notification.dto';
import {
  NotificationListResponse,
  NotificationResponse,
  toNotificationListResponse,
  toNotificationResponse,
} from '../dtos/notification.response';

/**
 * The in-app notification center (module-13 Work 01, design §8.1).
 *
 *     GET  /notifications                ?unread=true|false &page &size — newest first
 *     GET  /notifications/unread-count
 *     POST /notifications/:id/read
 *     POST /notifications/read-all
 *
 * ## Own data only, structurally
 *
 * Every handler takes the owner from `@CurrentUser()` and passes nothing else as an owner; no
 * route accepts a user id, and the repository has no method that reaches a notification without
 * one. Another user's notification answers `404 NOT_FOUND`, exactly as an unknown id does — the
 * repository's ownership convention. A malformed id is `400` (`ParseUUIDPipe`).
 *
 * ## Authorization — `notification:read:own`
 *
 * Granted to every role (each holds `profile:read:own` too), and to `SUPER_ADMIN` by wildcard.
 * Marking a notification read changes only the caller's own inbox state, which the same key
 * covers, as `profile:read:own` covers reading the profile it belongs to.
 *
 * ## Audit
 *
 * Nothing is written: reads are not audited (no sensitive-read convention exists), and marking
 * one's own notification read is inbox state, not an administrative act.
 */
@Controller('notifications')
@RequirePermissions('notification:read:own')
export class NotificationsController {
  constructor(
    private readonly listNotifications: ListNotificationsQuery,
    private readonly unreadCount: GetUnreadCountQuery,
    private readonly markRead: MarkNotificationReadCommand,
    private readonly markAllRead: MarkAllNotificationsReadCommand,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<NotificationListResponse> {
    return toNotificationListResponse(
      await this.listNotifications.execute({
        recipientUserId: user.userId,
        unread: query.unread === undefined ? undefined : query.unread === 'true',
        page: query.page,
        size: query.size,
      }),
    );
  }

  @Get('unread-count')
  async count(@CurrentUser() user: AuthenticatedPrincipal): Promise<{ unread: number }> {
    return this.unreadCount.execute(user.userId);
  }

  // Declared before `:id/read` only for readability — the two paths cannot collide.
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async readAll(@CurrentUser() user: AuthenticatedPrincipal): Promise<{ updated: number }> {
    return this.markAllRead.execute(user.userId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async read(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<NotificationResponse> {
    return toNotificationResponse(await this.markRead.execute({ recipientUserId: user.userId, notificationId: id }));
  }
}
