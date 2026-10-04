import { ISessionRepository, SessionRecord } from '../../domain/repositories/auth.repositories';
import { RevokeSessionCommand } from './revoke-session.command';

function fakeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    userId: 'user-1',
    deviceId: 'device-1',
    ip: null,
    userAgent: null,
    createdAt: new Date(),
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    ...overrides,
  };
}

describe('RevokeSessionCommand', () => {
  it('revokes a session owned by the requesting user', async () => {
    const sessions = {
      findById: jest.fn().mockResolvedValue(fakeSession()),
      revoke: jest.fn(),
    } as unknown as ISessionRepository;

    const command = new RevokeSessionCommand(sessions);
    await command.execute('user-1', 'session-1');

    expect(sessions.revoke).toHaveBeenCalledWith('session-1');
  });

  it('rejects revoking a session owned by someone else', async () => {
    const sessions = {
      findById: jest.fn().mockResolvedValue(fakeSession({ userId: 'someone-else' })),
      revoke: jest.fn(),
    } as unknown as ISessionRepository;

    const command = new RevokeSessionCommand(sessions);
    await expect(command.execute('user-1', 'session-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(sessions.revoke).not.toHaveBeenCalled();
  });

  it('rejects an unknown session', async () => {
    const sessions = {
      findById: jest.fn().mockResolvedValue(null),
      revoke: jest.fn(),
    } as unknown as ISessionRepository;

    const command = new RevokeSessionCommand(sessions);
    await expect(command.execute('user-1', 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
