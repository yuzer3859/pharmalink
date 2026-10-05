import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_NOTIFICATION_PAGE_SIZE } from '../../application/queries/list-notifications.query';

/**
 * `GET /notifications` query string. No owner field of any kind: the list is always the
 * authenticated principal's, and `forbidNonWhitelisted` rejects a `recipientUserId`, `userId` or
 * `actorUserId` a client tries to add.
 */
export class ListNotificationsQueryDto {
  /**
   * The literal strings `true` / `false`, compared rather than coerced: implicit conversion would
   * turn `"false"` into `true` (`Boolean("false")`). Same shape `env.validation.ts` uses for
   * boolean flags.
   */
  @IsIn(['true', 'false'])
  @IsOptional()
  unread?: 'true' | 'false';

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_NOTIFICATION_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
