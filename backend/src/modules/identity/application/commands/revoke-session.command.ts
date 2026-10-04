import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ISessionRepository, SESSION_REPOSITORY } from '../../domain/repositories/auth.repositories';

/** DELETE /auth/sessions/{id} (module-01 §3.5 F-DEV-02, §11.4). Ownership-checked. */
@Injectable()
export class RevokeSessionCommand {
  constructor(@Inject(SESSION_REPOSITORY) private readonly sessions: ISessionRepository) {}

  async execute(userId: string, sessionId: string): Promise<void> {
    const session = await this.sessions.findById(sessionId);
    if (!session || session.userId !== userId) {
      // Generic 404 — do not reveal whether the session belongs to someone else.
      throw ApiException.notFound('Session not found');
    }
    await this.sessions.revoke(sessionId);
  }
}
