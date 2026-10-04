import { ISessionRepository, SessionRecord } from '../../domain/repositories/auth.repositories';
import { ListSessionsQuery } from './list-sessions.query';

function fakeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    userId: 'user-1',
    deviceId: 'device-1',
    ip: '10.0.0.1',
    userAgent: 'agent',
    createdAt: new Date(),
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    ...overrides,
  };
}

describe('ListSessionsQuery', () => {
  it('maps session records to the API view', async () => {
    const sessions = {
      listActiveForUser: jest.fn().mockResolvedValue([fakeSession()]),
    } as unknown as ISessionRepository;

    const query = new ListSessionsQuery(sessions);
    const result = await query.execute('user-1');

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('session-1');
    expect(sessions.listActiveForUser).toHaveBeenCalledWith('user-1');
  });
});
