import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AccountStatus, OtpPurpose, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { Email } from '../../domain/value-objects/email';
import { PasswordPolicy } from '../../domain/value-objects/password-policy';
import {
  BootstrapInspection,
  IPlatformBootstrapRepository,
  PLATFORM_BOOTSTRAP_REPOSITORY,
} from '../../domain/repositories/platform-bootstrap.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import { HASHER, IHasher } from '../ports/hasher.port';
import { INotificationPort, NOTIFICATION_PORT } from '../ports/notification.port';
import { IOtpStoreProbe, OTP_STORE_PROBE } from '../ports/otp-store-probe.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { ResendOtpCommand } from './resend-otp.command';

export type BootstrapRefusalReason =
  | 'PRODUCTION_REFUSED'
  | 'ROLE_CATALOGUE_MISSING'
  | 'ALREADY_COMPLETED'
  | 'SUPER_ADMIN_EXISTS'
  | 'EMAIL_NOT_CONFIGURED'
  | 'OTP_STORE_NOT_SHARED'
  | 'OTP_STORE_UNAVAILABLE'
  | 'INVALID_EMAIL'
  | 'WEAK_PASSWORD'
  | 'EMAIL_IN_USE';

/**
 * The bootstrap was refused before anything was written (or, for `ALREADY_COMPLETED`, because a
 * concurrent run won). Messages are for the operator's terminal; none contains a secret.
 */
export class BootstrapRefusedError extends Error {
  constructor(
    readonly reason: BootstrapRefusalReason,
    message: string,
    readonly requirements: string[] = [],
  ) {
    super(message);
    this.name = 'BootstrapRefusedError';
  }
}

export interface BootstrapSuperAdminInput {
  email: string;
  password: string;
}

export interface BootstrapSuperAdminResult {
  userId: string;
  /** Masked, for the operator's confirmation message. */
  maskedEmail: string;
  /**
   * `SENT`: the provider accepted the verification e-mail. `NOT_SENT`: the account and marker
   * exist, the account stays PENDING_VERIFICATION, and the code must be re-requested with the normal
   * resend flow after `retryAfterSeconds`.
   */
  delivery: 'SENT' | 'NOT_SENT';
  retryAfterSeconds?: number;
}

const refuse = (reason: BootstrapRefusalReason, message: string, requirements?: string[]) =>
  new BootstrapRefusedError(reason, message, requirements);

/**
 * One-time, operator-only creation of the first Super Admin (Work 65). Runs only from the CLI
 * (`npm run admin:bootstrap-super-admin`); no HTTP route reaches it.
 *
 * - **Refused in production** until mandatory administrator MFA exists (module-01 requires MFA for
 *   ADMIN/SUPER_ADMIN; `LoginUserCommand` does not enforce it yet).
 * - **Preconditions before any write:** the RBAC seed applied (SUPER_ADMIN, PLATFORM scope, `*`),
 *   the marker unused, no Super Admin present, e-mail deliverable, and a shared OTP store reachable
 *   (the CLI issues the code; the HTTP server verifies it).
 * - **Normal identity lifecycle:** the password goes through `PasswordPolicy` and `IHasher`; the
 *   account starts PENDING_VERIFICATION with no verified e-mail and no Fayda verification, and only
 *   `POST /auth/verify-otp` activates it.
 * - **Atomic and one-time:** user, global SUPER_ADMIN assignment, marker and audit entry commit
 *   together at Serializable isolation. The marker's fixed primary key means a concurrent second
 *   run fails or, on retry, sees the completed bootstrap.
 * - **One code:** no `UserRegistered` event is written (its handler would send a second code, and
 *   Profiles would create a customer profile for an administrator). The code is sent once, through
 *   the same `ResendOtpCommand` path the handler uses, so delivery is truthful.
 */
@Injectable()
export class BootstrapSuperAdminCommand {
  private readonly passwordPolicy = new PasswordPolicy();

  constructor(
    private readonly config: AppConfigService,
    @Inject(PLATFORM_BOOTSTRAP_REPOSITORY) private readonly bootstrap: IPlatformBootstrapRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(HASHER) private readonly hasher: IHasher,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    @Inject(NOTIFICATION_PORT) private readonly notifications: INotificationPort,
    @Inject(OTP_STORE_PROBE) private readonly otpStore: IOtpStoreProbe,
    private readonly resendOtp: ResendOtpCommand,
    private readonly audit: AuditService,
  ) {}

  /** Every check that needs no credentials. Writes nothing. */
  async checkPreconditions(): Promise<void> {
    if (this.config.isProduction) {
      throw refuse(
        'PRODUCTION_REFUSED',
        'Refusing to bootstrap in production: mandatory administrator MFA is not implemented yet.',
      );
    }
    this.assertBootstrappable(await this.bootstrap.inspect());

    if (!this.notifications.canDeliver('EMAIL')) {
      throw refuse(
        'EMAIL_NOT_CONFIGURED',
        'E-mail delivery is not configured (RESEND_API_KEY and RESEND_FROM_EMAIL), so the verification code could not be sent.',
      );
    }
    let shared: boolean;
    try {
      ({ shared } = await this.otpStore.probe());
    } catch {
      throw refuse('OTP_STORE_UNAVAILABLE', 'The OTP store (Redis) is not reachable.');
    }
    if (!shared) {
      throw refuse(
        'OTP_STORE_NOT_SHARED',
        'The OTP store is in-memory (OTP_STORE=memory). Use OTP_STORE=redis with the same Redis as the backend, so the server can verify the code this command issues.',
      );
    }
  }

  async execute(input: BootstrapSuperAdminInput): Promise<BootstrapSuperAdminResult> {
    await this.checkPreconditions();

    let email: Email;
    try {
      email = Email.create(input.email);
    } catch {
      throw refuse('INVALID_EMAIL', 'That is not a valid e-mail address.');
    }
    const unmet = this.passwordPolicy.check(input.password);
    if (unmet.length > 0) {
      throw refuse('WEAK_PASSWORD', 'The password does not meet the password policy.', unmet);
    }
    if (await this.users.findByEmail(email.value)) {
      throw refuse('EMAIL_IN_USE', 'An account with this e-mail address already exists.');
    }
    const passwordHash = await this.hasher.hash(input.password);

    let userId: string;
    try {
      userId = await this.uow.run(
        async (tx) => {
          const state = await this.bootstrap.inspect(tx);
          const role = this.assertBootstrappable(state);
          const user = await this.users.create(
            {
              phone: null,
              email: email.value,
              passwordHash,
              primaryRole: PrimaryRole.SUPER_ADMIN,
              status: AccountStatus.PENDING_VERIFICATION,
              preferredLanguage: PreferredLanguage.en,
            },
            tx,
          );
          const { assignmentId } = await this.bootstrap.assignSuperAdminRole(user.id, role.id, tx);
          await this.bootstrap.markCompleted(user.id, tx);
          await this.audit.record(
            {
              actorUserId: null,
              action: 'identity.platform.super_admin_bootstrapped',
              resourceType: 'user',
              resourceId: user.id,
              context: { roleKey: 'SUPER_ADMIN', assignmentId, email: email.masked(), via: 'cli' },
            },
            tx,
          );
          return user.id;
        },
        { isolation: 'serializable' },
      );
    } catch (err) {
      if (err instanceof BootstrapRefusedError) throw err;
      // A concurrent run that committed first makes this one fail on the marker or a uniqueness
      // constraint; report what actually happened rather than the database error.
      const after = await this.bootstrap.inspect();
      if (after.completed) {
        throw refuse('ALREADY_COMPLETED', 'The first Super Admin bootstrap has already been completed.');
      }
      throw err;
    }

    try {
      await this.resendOtp.execute({ identifier: email.value, purpose: OtpPurpose.REGISTER });
      return { userId, maskedEmail: email.masked(), delivery: 'SENT' };
    } catch (err) {
      // The account and marker stay: the account is PENDING_VERIFICATION and can't sign in, and a
      // second bootstrap must not become possible. The normal resend flow recovers it.
      if (
        err instanceof ApiException &&
        (err.code === ErrorCode.DEPENDENCY_UNAVAILABLE || err.code === ErrorCode.RATE_LIMITED)
      ) {
        const details = err.details as { retryAfterSeconds?: unknown } | undefined;
        const retry = Number(details?.retryAfterSeconds);
        return {
          userId,
          maskedEmail: email.masked(),
          delivery: 'NOT_SENT',
          ...(Number.isFinite(retry) ? { retryAfterSeconds: retry } : {}),
        };
      }
      throw err;
    }
  }

  private assertBootstrappable(state: BootstrapInspection): { id: string } {
    const role = state.superAdminRole;
    if (!role || role.scope !== 'PLATFORM' || !role.hasWildcard) {
      throw refuse(
        'ROLE_CATALOGUE_MISSING',
        'The SUPER_ADMIN role or its wildcard permission is missing. Run the RBAC seed (npm run prisma:seed) first.',
      );
    }
    if (state.completed) {
      throw refuse('ALREADY_COMPLETED', 'The first Super Admin bootstrap has already been completed.');
    }
    if (state.superAdminExists) {
      throw refuse(
        'SUPER_ADMIN_EXISTS',
        'A Super Admin account or SUPER_ADMIN assignment already exists without a bootstrap record. Review the database; this command will not create another.',
      );
    }
    return role;
  }
}
