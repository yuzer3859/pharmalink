import { LoginOutcome } from '../../domain/enums';
import { ILoginHistoryRepository, LoginHistoryRecord } from '../../domain/repositories/auth.repositories';
import { GetLoginHistoryQuery } from './get-login-history.query';

function fakeRecord(overrides: Partial<LoginHistoryRecord> = {}): LoginHistoryRecord {
  return {
    id: 'lh-1',
    userId: 'user-1',
    identifier: '+251912345678',
    deviceId: null,
    ip: '10.0.0.1',
    userAgent: 'agent',
    outcome: LoginOutcome.SUCCESS,
    failureReason: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('GetLoginHistoryQuery', () => {
  it('paginates and maps login-history records', async () => {
    const loginHistory = {
      listForUser: jest.fn().mockResolvedValue({
        items: [fakeRecord()],
        total: 1,
        page: 1,
        size: 20,
      }),
    } as unknown as ILoginHistoryRepository;

    const query = new GetLoginHistoryQuery(loginHistory);
    const result = await query.execute('user-1');

    expect(loginHistory.listForUser).toHaveBeenCalledWith('user-1', 1, 20);
    expect(result.total).toBe(1);
    expect(result.items[0].outcome).toBe(LoginOutcome.SUCCESS);
  });

  it('passes through custom pagination', async () => {
    const loginHistory = {
      listForUser: jest.fn().mockResolvedValue({ items: [], total: 0, page: 2, size: 5 }),
    } as unknown as ILoginHistoryRepository;

    const query = new GetLoginHistoryQuery(loginHistory);
    await query.execute('user-1', 2, 5);

    expect(loginHistory.listForUser).toHaveBeenCalledWith('user-1', 2, 5);
  });
});
