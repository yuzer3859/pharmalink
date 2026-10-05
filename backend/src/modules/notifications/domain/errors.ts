import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Notifications domain/application errors, translated to the standard error envelope by the
 * global AllExceptionsFilter.
 */
export const NotificationErrors = {
  /**
   * An unknown notification and another user's notification are the same answer — the
   * repository's ownership convention (a different customer gets `404`, not `403`, on someone
   * else's address), so a caller cannot probe which ids exist.
   */
  notFound: () => new ApiException(ErrorCode.NOT_FOUND, 'Notification not found.'),
};
