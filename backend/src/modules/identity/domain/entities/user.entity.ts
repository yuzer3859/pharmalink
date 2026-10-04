import { AccountStatus, PreferredLanguage, PrimaryRole } from '../enums';
import { IdentityErrors } from '../errors';

export interface UserProps {
  id: string;
  phone: string | null;
  email: string | null;
  passwordHash: string | null;
  primaryRole: PrimaryRole;
  status: AccountStatus;
  preferredLanguage: PreferredLanguage;
  phoneVerifiedAt: Date | null;
  emailVerifiedAt: Date | null;
  faydaVerifiedAt: Date | null;
  guardianId: string | null;
  permVersion: number;
  deletionRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * User aggregate root (module-01 §10). Encapsulates account-status invariants and verification
 * transitions. Framework-free: no Prisma/Nest imports. Repositories reconstitute via `rehydrate`
 * and persist via `toProps`.
 */
export class User {
  private constructor(private props: UserProps) {}

  static rehydrate(props: UserProps): User {
    return new User(props);
  }

  get id(): string {
    return this.props.id;
  }
  get phone(): string | null {
    return this.props.phone;
  }
  get email(): string | null {
    return this.props.email;
  }
  get passwordHash(): string | null {
    return this.props.passwordHash;
  }
  get primaryRole(): PrimaryRole {
    return this.props.primaryRole;
  }
  get status(): AccountStatus {
    return this.props.status;
  }
  get preferredLanguage(): PreferredLanguage {
    return this.props.preferredLanguage;
  }
  get permVersion(): number {
    return this.props.permVersion;
  }
  get deletionRequestedAt(): Date | null {
    return this.props.deletionRequestedAt;
  }
  get phoneVerifiedAt(): Date | null {
    return this.props.phoneVerifiedAt;
  }
  get emailVerifiedAt(): Date | null {
    return this.props.emailVerifiedAt;
  }

  /** True if the account can complete an authentication (login/refresh) right now. */
  assertCanAuthenticate(): void {
    switch (this.props.status) {
      case AccountStatus.ACTIVE:
        return;
      case AccountStatus.SUSPENDED:
        throw IdentityErrors.accountSuspended();
      case AccountStatus.PENDING_VERIFICATION:
      case AccountStatus.PENDING_APPROVAL:
      case AccountStatus.REJECTED:
      case AccountStatus.DEACTIVATED:
      case AccountStatus.DELETED:
      default:
        // Generic to avoid leaking exact lifecycle state to unauthenticated callers.
        throw IdentityErrors.invalidCredentials();
    }
  }

  /** Marks the phone verified; activates a PENDING_VERIFICATION customer (module-01 §7.1). */
  markPhoneVerified(now: Date = new Date()): void {
    this.props.phoneVerifiedAt = now;
    this.props.updatedAt = now;
    if (this.props.status === AccountStatus.PENDING_VERIFICATION) {
      this.props.status = AccountStatus.ACTIVE;
    }
  }

  markEmailVerified(now: Date = new Date()): void {
    this.props.emailVerifiedAt = now;
    this.props.updatedAt = now;
    if (
      this.props.status === AccountStatus.PENDING_VERIFICATION &&
      this.props.phone === null
    ) {
      this.props.status = AccountStatus.ACTIVE;
    }
  }

  /**
   * Replaces the credential (reset or authenticated change, module-01 §7.7, §11.3). The caller
   * supplies an already-hashed value — hashing lives behind the IHasher port, never in the domain.
   */
  changePassword(passwordHash: string, now: Date = new Date()): void {
    if (!passwordHash) {
      throw IdentityErrors.validation('A password hash is required.');
    }
    this.props.passwordHash = passwordHash;
    this.props.updatedAt = now;
  }

  /** Records Fayda identity assurance (module-01 §9.2 step 7). */
  markFaydaVerified(now: Date = new Date()): void {
    this.props.faydaVerifiedAt = now;
    this.props.updatedAt = now;
  }

  /**
   * Provider approval outcome (module-01 §9.2 step 7). Only lifts an account that is waiting on
   * that approval; an already-ACTIVE provider (e.g. renewing a licence) is left untouched.
   */
  approveProviderAccess(now: Date = new Date()): void {
    if (this.props.status === AccountStatus.PENDING_APPROVAL) {
      this.props.status = AccountStatus.ACTIVE;
      this.props.updatedAt = now;
    }
  }

  /** Provider rejection outcome — the user may correct and resubmit (module-01 §9.2 step 7). */
  rejectProviderAccess(now: Date = new Date()): void {
    if (this.props.status === AccountStatus.PENDING_APPROVAL) {
      this.props.status = AccountStatus.REJECTED;
      this.props.updatedAt = now;
    }
  }

  /**
   * Admin suspension (module-01 §11.7, F-RBAC/BR-IAM). Terminal states cannot be suspended, and
   * suspending an already-suspended account is a no-op rather than an error so the endpoint stays
   * idempotent for retrying admin tooling.
   */
  suspend(now: Date = new Date()): void {
    if (this.props.status === AccountStatus.SUSPENDED) {
      return;
    }
    if (
      this.props.status === AccountStatus.DELETED ||
      this.props.status === AccountStatus.DEACTIVATED
    ) {
      throw IdentityErrors.invalidStatusTransition(this.props.status, AccountStatus.SUSPENDED);
    }
    this.props.status = AccountStatus.SUSPENDED;
    this.props.updatedAt = now;
  }

  /** Reverses a suspension. Only a SUSPENDED account can be reactivated. */
  reactivate(now: Date = new Date()): void {
    if (this.props.status !== AccountStatus.SUSPENDED) {
      throw IdentityErrors.invalidStatusTransition(this.props.status, AccountStatus.ACTIVE);
    }
    this.props.status = AccountStatus.ACTIVE;
    this.props.updatedAt = now;
  }

  changeLanguage(language: PreferredLanguage, now: Date = new Date()): void {
    this.props.preferredLanguage = language;
    this.props.updatedAt = now;
  }

  /**
   * Self-service deactivation (module-01 §3.7 FR-AC-12, §11.5). Reversible by support via
   * reactivation; a terminal account cannot be deactivated again.
   */
  deactivate(now: Date = new Date()): void {
    if (this.props.status === AccountStatus.DEACTIVATED) {
      return;
    }
    if (this.props.status === AccountStatus.DELETED) {
      throw IdentityErrors.invalidStatusTransition(this.props.status, AccountStatus.DEACTIVATED);
    }
    this.props.status = AccountStatus.DEACTIVATED;
    this.props.updatedAt = now;
  }

  /**
   * Records a data-deletion request (NFR-PRIV-04, module-01 §11.5). The account is deactivated
   * immediately so it can no longer be used, while the record itself survives the retention grace
   * period for the scheduled purge. Repeat requests keep the original timestamp — restarting the
   * clock would let a user postpone their own erasure indefinitely.
   */
  requestDeletion(now: Date = new Date()): void {
    if (this.props.status === AccountStatus.DELETED) {
      throw IdentityErrors.invalidStatusTransition(this.props.status, AccountStatus.DELETED);
    }
    this.props.deletionRequestedAt = this.props.deletionRequestedAt ?? now;
    this.props.status = AccountStatus.DEACTIVATED;
    this.props.updatedAt = now;
  }

  bumpPermVersion(now: Date = new Date()): void {
    this.props.permVersion += 1;
    this.props.updatedAt = now;
  }

  toProps(): Readonly<UserProps> {
    return { ...this.props };
  }
}
