import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { INotificationPort, NotificationRequest } from '../../application/ports/notification.port';

/**
 * Log-only notification adapter (module-01 §15 / shared-conventions §15). Stands in for the
 * real Module 13 (Notifications) integration during this slice — logs the request with the
 * recipient masked so nothing sensitive (OTP codes excluded by callers) ever appears in logs.
 */
@Injectable()
export class LogNotificationAdapter implements INotificationPort {
  constructor(private readonly logger: AppLogger) {
    this.logger.setContext(LogNotificationAdapter.name);
  }

  async send(request: NotificationRequest): Promise<void> {
    this.logger.log(
      `[mock] ${request.channel} -> ${this.mask(request.to)} template=${request.template}`,
    );
  }

  private mask(to: string): string {
    return to.length <= 4 ? '****' : `${to.slice(0, 3)}****${to.slice(-2)}`;
  }
}
