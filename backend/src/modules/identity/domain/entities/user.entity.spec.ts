import { AccountStatus, PreferredLanguage, PrimaryRole } from '../enums';
import { User, UserProps } from './user.entity';

function makeUser(overrides: Partial<UserProps> = {}): User {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return User.rehydrate({
    id: 'user-1',
    phone: '+251912345678',
    email: null,
    passwordHash: 'hash',
    primaryRole: PrimaryRole.CUSTOMER,
    status: AccountStatus.PENDING_VERIFICATION,
    preferredLanguage: PreferredLanguage.en,
    phoneVerifiedAt: null,
    emailVerifiedAt: null,
    faydaVerifiedAt: null,
    guardianId: null,
    permVersion: 1,
    deletionRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  });
}

describe('User entity', () => {
  it('activates a pending-verification account on phone verification', () => {
    const user = makeUser();
    user.markPhoneVerified();
    expect(user.status).toBe(AccountStatus.ACTIVE);
    expect(user.phoneVerifiedAt).not.toBeNull();
  });

  it('does not activate an already-suspended account on verification', () => {
    const user = makeUser({ status: AccountStatus.SUSPENDED });
    user.markPhoneVerified();
    expect(user.status).toBe(AccountStatus.SUSPENDED);
  });

  it('allows authentication only when ACTIVE', () => {
    const active = makeUser({ status: AccountStatus.ACTIVE });
    expect(() => active.assertCanAuthenticate()).not.toThrow();
  });

  it('rejects authentication for a suspended account with AUTH_ACCOUNT_SUSPENDED', () => {
    const suspended = makeUser({ status: AccountStatus.SUSPENDED });
    expect(() => suspended.assertCanAuthenticate()).toThrow();
  });

  it('rejects authentication for a pending-verification account generically', () => {
    const pending = makeUser({ status: AccountStatus.PENDING_VERIFICATION });
    expect(() => pending.assertCanAuthenticate()).toThrow();
  });

  it('bumps the permission version', () => {
    const user = makeUser();
    expect(user.permVersion).toBe(1);
    user.bumpPermVersion();
    expect(user.permVersion).toBe(2);
  });

  it('suspends an active account', () => {
    const user = makeUser({ status: AccountStatus.ACTIVE });
    user.suspend();
    expect(user.status).toBe(AccountStatus.SUSPENDED);
  });

  it('treats suspending an already-suspended account as a no-op', () => {
    const user = makeUser({ status: AccountStatus.SUSPENDED });
    expect(() => user.suspend()).not.toThrow();
    expect(user.status).toBe(AccountStatus.SUSPENDED);
  });

  it('refuses to suspend a terminal account', () => {
    expect(() => makeUser({ status: AccountStatus.DELETED }).suspend()).toThrow();
    expect(() => makeUser({ status: AccountStatus.DEACTIVATED }).suspend()).toThrow();
  });

  it('reactivates only from SUSPENDED', () => {
    const suspended = makeUser({ status: AccountStatus.SUSPENDED });
    suspended.reactivate();
    expect(suspended.status).toBe(AccountStatus.ACTIVE);

    expect(() => makeUser({ status: AccountStatus.ACTIVE }).reactivate()).toThrow();
    expect(() => makeUser({ status: AccountStatus.PENDING_VERIFICATION }).reactivate()).toThrow();
  });

  it('deactivates an active account and is idempotent', () => {
    const user = makeUser({ status: AccountStatus.ACTIVE });
    user.deactivate();
    expect(user.status).toBe(AccountStatus.DEACTIVATED);
    expect(() => user.deactivate()).not.toThrow();
  });

  it('refuses to deactivate an erased account', () => {
    expect(() => makeUser({ status: AccountStatus.DELETED }).deactivate()).toThrow();
  });

  it('records a deletion request and disables the account', () => {
    const user = makeUser({ status: AccountStatus.ACTIVE });
    user.requestDeletion();

    expect(user.deletionRequestedAt).not.toBeNull();
    expect(user.status).toBe(AccountStatus.DEACTIVATED);
  });

  it('does not restart the retention clock on a repeat deletion request', () => {
    const firstRequest = new Date('2026-01-01T00:00:00.000Z');
    const user = makeUser({ status: AccountStatus.ACTIVE, deletionRequestedAt: firstRequest });

    user.requestDeletion(new Date('2026-06-01T00:00:00.000Z'));

    expect(user.deletionRequestedAt).toEqual(firstRequest);
  });

  it('changes the preferred language', () => {
    const user = makeUser();
    user.changeLanguage(PreferredLanguage.am);
    expect(user.preferredLanguage).toBe(PreferredLanguage.am);
  });

  it('toProps returns a snapshot equal to construction input', () => {
    const user = makeUser();
    expect(user.toProps().id).toBe('user-1');
    expect(user.toProps().primaryRole).toBe(PrimaryRole.CUSTOMER);
  });
});
