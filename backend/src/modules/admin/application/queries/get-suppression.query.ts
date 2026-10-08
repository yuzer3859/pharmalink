import { Inject, Injectable } from '@nestjs/common';
import {
  INotificationSuppressionAdminPort,
  NOTIFICATION_SUPPRESSION_ADMIN_PORT,
  SuppressionView,
} from '../../../notifications/application/ports/inbound/notification-suppression-admin.port';
import { AdminErrors } from '../../domain/errors';

/** `GET /admin/notifications/suppressions/:id` (module-13 Work 19). Unknown → 404. Not audited. */
@Injectable()
export class GetSuppressionQuery {
  constructor(@Inject(NOTIFICATION_SUPPRESSION_ADMIN_PORT) private readonly suppressions: INotificationSuppressionAdminPort) {}

  async execute(id: string): Promise<SuppressionView> {
    const view = await this.suppressions.getSuppression(id);
    if (!view) throw AdminErrors.suppressionNotFound();
    return view;
  }
}
