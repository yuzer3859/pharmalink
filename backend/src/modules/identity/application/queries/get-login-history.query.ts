import { Inject, Injectable } from '@nestjs/common';
import { LoginOutcome } from '../../domain/enums';
import {
  ILoginHistoryRepository,
  LOGIN_HISTORY_REPOSITORY,
  PaginatedResult,
} from '../../domain/repositories/auth.repositories';

export interface LoginHistoryView {
  id: string;
  identifier: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  outcome: LoginOutcome;
  failureReason: string | null;
  createdAt: Date;
}

/** GET /auth/login-history (module-01 §3.5 F-DEV-03 / FR-AC-11, §11.4). */
@Injectable()
export class GetLoginHistoryQuery {
  constructor(
    @Inject(LOGIN_HISTORY_REPOSITORY) private readonly loginHistory: ILoginHistoryRepository,
  ) {}

  async execute(
    userId: string,
    page = 1,
    size = 20,
  ): Promise<PaginatedResult<LoginHistoryView>> {
    const result = await this.loginHistory.listForUser(userId, page, size);
    return {
      ...result,
      items: result.items.map((r) => ({
        id: r.id,
        identifier: r.identifier,
        deviceId: r.deviceId,
        ip: r.ip,
        userAgent: r.userAgent,
        outcome: r.outcome,
        failureReason: r.failureReason ?? null,
        createdAt: r.createdAt,
      })),
    };
  }
}
