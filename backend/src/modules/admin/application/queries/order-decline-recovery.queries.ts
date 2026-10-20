import { Inject, Injectable } from '@nestjs/common';
import {
  DECLINE_RECOVERY_READ_PORT,
  DeclineRecoveryPage,
  DeclineRecoveryState,
  IDeclineRecoveryReadPort,
} from '../../../orders/application/ports/inbound/decline-recovery-read.port';

export const MAX_DECLINE_RECOVERY_PAGE_SIZE = 100;
const DEFAULT_SIZE = 20;

/**
 * `GET /admin/operations/order-decline-recovery` (module-16, Work 55): orders that went through a
 * pharmacy decline, segment by segment — confirmation pending, failed, orphaned before Phase 3a, or
 * resolved — through Module 06's derived `DECLINE_RECOVERY_READ_PORT`. Paging over candidate orders,
 * clamped to 1..100 (default 20). Read-only.
 */
@Injectable()
export class ListOrderDeclineRecoveryQuery {
  constructor(@Inject(DECLINE_RECOVERY_READ_PORT) private readonly declines: IDeclineRecoveryReadPort) {}

  execute(input: { state?: DeclineRecoveryState; page?: number; size?: number }): Promise<DeclineRecoveryPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : 1;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_DECLINE_RECOVERY_PAGE_SIZE)
        : DEFAULT_SIZE;
    return this.declines.list({ state: input.state }, page, size);
  }
}
