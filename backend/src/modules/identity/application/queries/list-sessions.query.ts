import { Inject, Injectable } from '@nestjs/common';
import { ISessionRepository, SESSION_REPOSITORY } from '../../domain/repositories/auth.repositories';

export interface SessionView {
  sessionId: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
}

/** GET /auth/sessions (module-01 §3.5 F-DEV-03, §11.4). */
@Injectable()
export class ListSessionsQuery {
  constructor(@Inject(SESSION_REPOSITORY) private readonly sessions: ISessionRepository) {}

  async execute(userId: string): Promise<SessionView[]> {
    const records = await this.sessions.listActiveForUser(userId);
    return records.map((r) => ({
      sessionId: r.id,
      deviceId: r.deviceId,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
    }));
  }
}
