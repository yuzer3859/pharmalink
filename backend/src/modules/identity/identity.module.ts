import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from '../../shared/rbac/permissions.guard';
import { PERMISSION_RESOLVER } from '../../shared/rbac/rbac.types';
import { ApproveVerificationCommand } from './application/commands/approve-verification.command';
import { AssignUserRoleCommand } from './application/commands/assign-user-role.command';
import { ChangePasswordCommand } from './application/commands/change-password.command';
import { DeactivateAccountCommand } from './application/commands/deactivate-account.command';
import { ExpireVerificationsCommand } from './application/commands/expire-verifications.command';
import { ForgotPasswordCommand } from './application/commands/forgot-password.command';
import { LoginUserCommand } from './application/commands/login-user.command';
import { LogoutAllCommand, LogoutCommand } from './application/commands/logout.command';
import { ReactivateUserCommand } from './application/commands/reactivate-user.command';
import { RefreshTokenCommand } from './application/commands/refresh-token.command';
import { RejectVerificationCommand } from './application/commands/reject-verification.command';
import { RequestAccountDeletionCommand } from './application/commands/request-account-deletion.command';
import { ResetPasswordCommand } from './application/commands/reset-password.command';
import { RegisterUserCommand } from './application/commands/register-user.command';
import { ResendOtpCommand } from './application/commands/resend-otp.command';
import { RevokeUserRoleCommand } from './application/commands/revoke-user-role.command';
import { SetRolePermissionsCommand } from './application/commands/set-role-permissions.command';
import { SubmitFaydaVerificationCommand } from './application/commands/submit-fayda-verification.command';
import { SubmitVerificationDocumentsCommand } from './application/commands/submit-verification-documents.command';
import { SuspendUserCommand } from './application/commands/suspend-user.command';
import { UpdateProfileCommand } from './application/commands/update-profile.command';
import { VerifyOtpCommand } from './application/commands/verify-otp.command';
import { HASHER } from './application/ports/hasher.port';
import {
  IDENTITY_ADMIN_PORT,
  IdentityAdminPortAdapter,
} from './application/ports/inbound/identity-admin.port';
import { IDENTITY_ANALYTICS_READ_PORT } from './application/ports/inbound/identity-analytics-read.port';
import { NOTIFICATION_PORT } from './application/ports/notification.port';
import { OTP_SERVICE } from './application/ports/otp.service';
import { IDENTITY_VERIFICATION_PROVIDER } from './application/ports/identity-verification.provider';
import { PERM_VERSION_STORE } from './application/ports/perm-version.port';
import { PERMISSION_CACHE_INVALIDATOR } from './application/ports/permission-cache.port';
import { TOKEN_SERVICE } from './application/ports/token.service';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port';
import { GetCurrentUserQuery } from './application/queries/get-current-user.query';
import { GetLoginHistoryQuery } from './application/queries/get-login-history.query';
import { ListDevicesQuery } from './application/queries/list-devices.query';
import { ListPermissionsQuery } from './application/queries/list-permissions.query';
import { ListRolesQuery } from './application/queries/list-roles.query';
import { ListSessionsQuery } from './application/queries/list-sessions.query';
import { ListUserRolesQuery } from './application/queries/list-user-roles.query';
import { ListVerificationQueueQuery } from './application/queries/list-verification-queue.query';
import { GetVerificationStatusQuery } from './application/queries/get-verification-status.query';
import { RevokeDeviceCommand } from './application/commands/revoke-device.command';
import { RevokeSessionCommand } from './application/commands/revoke-session.command';
import { AuthSessionIssuerService } from './application/services/auth-session-issuer.service';
import { PermissionChangeService } from './application/services/permission-change.service';
import {
  DEVICE_REPOSITORY,
  LOGIN_HISTORY_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
} from './domain/repositories/auth.repositories';
import { USER_REPOSITORY } from './domain/repositories/user.repository';
import { RBAC_REPOSITORY } from './domain/repositories/rbac.repository';
import {
  CONSENT_REPOSITORY,
  VERIFICATION_REPOSITORY,
} from './domain/repositories/verification.repository';
import { ROLE_ASSIGNMENT_REPOSITORY } from './domain/repositories/role-assignment.repository';
import { LogNotificationAdapter } from './infrastructure/messaging/log-notification.adapter';
import { InMemoryOtpService } from './infrastructure/otp/in-memory-otp.service';
import {
  PrismaDeviceRepository,
  PrismaLoginHistoryRepository,
  PrismaRefreshTokenRepository,
  PrismaSessionRepository,
} from './infrastructure/persistence/prisma-auth.repositories';
import { PrismaUnitOfWork } from './infrastructure/persistence/prisma-unit-of-work';
import { PrismaUserRepository } from './infrastructure/persistence/prisma-user.repository';
import { PrismaIdentityAnalyticsReadAdapter } from './infrastructure/persistence/prisma-identity-analytics-read.adapter';
import { PrismaRbacRepository } from './infrastructure/persistence/prisma-rbac.repository';
import { PrismaRoleAssignmentRepository } from './infrastructure/persistence/prisma-role-assignment.repository';
import {
  PrismaConsentRepository,
  PrismaVerificationRepository,
} from './infrastructure/persistence/prisma-verification.repository';
import { LicenseExpiryJob } from './infrastructure/jobs/license-expiry.job';
import { MockFaydaProvider } from './infrastructure/verification/mock-fayda.provider';
import { PermissionCacheAdapter } from './infrastructure/rbac/permission-cache.adapter';
import { PrismaPermissionResolver } from './infrastructure/rbac/prisma-permission-resolver';
import { CachedPermVersionStore } from './infrastructure/security/cached-perm-version.store';
import { JwtTokenService } from './infrastructure/security/jwt-token.service';
import { ScryptHasher } from './infrastructure/security/scrypt-hasher';
import { AdminRbacController } from './interface/controllers/admin-rbac.controller';
import { AdminVerificationController } from './interface/controllers/admin-verification.controller';
import { VerificationController } from './interface/controllers/verification.controller';
import { AdminUsersController } from './interface/controllers/admin-users.controller';
import { AuthController } from './interface/controllers/auth.controller';
import { UsersController } from './interface/controllers/users.controller';
import { UserRegisteredHandler } from './interface/events/user-registered.handler';
import { JwtAuthGuard } from './interface/guards/jwt-auth.guard';

/**
 * Identity module composition root (module-01 §12). Wires every port to its Phase-0-slice
 * adapter (Prisma persistence, dependency-free scrypt/JWT security, in-memory OTP, log-only
 * notifications). Registers JwtAuthGuard + the shared PermissionsGuard globally — Phase 0
 * deliberately left this activation to Module 01 (see RbacModule).
 */
@Module({
  controllers: [
    AuthController,
    UsersController,
    AdminRbacController,
    AdminUsersController,
    VerificationController,
    AdminVerificationController,
  ],
  providers: [
    // Repositories
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: PrismaRefreshTokenRepository },
    { provide: SESSION_REPOSITORY, useClass: PrismaSessionRepository },
    { provide: DEVICE_REPOSITORY, useClass: PrismaDeviceRepository },
    { provide: LOGIN_HISTORY_REPOSITORY, useClass: PrismaLoginHistoryRepository },
    { provide: ROLE_ASSIGNMENT_REPOSITORY, useClass: PrismaRoleAssignmentRepository },
    { provide: RBAC_REPOSITORY, useClass: PrismaRbacRepository },
    { provide: VERIFICATION_REPOSITORY, useClass: PrismaVerificationRepository },
    { provide: CONSENT_REPOSITORY, useClass: PrismaConsentRepository },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },

    // Security / infra adapters
    { provide: HASHER, useClass: ScryptHasher },
    { provide: TOKEN_SERVICE, useClass: JwtTokenService },
    { provide: OTP_SERVICE, useClass: InMemoryOtpService },
    { provide: NOTIFICATION_PORT, useClass: LogNotificationAdapter },
    { provide: PERMISSION_RESOLVER, useClass: PrismaPermissionResolver },
    { provide: PERMISSION_CACHE_INVALIDATOR, useClass: PermissionCacheAdapter },
    { provide: PERM_VERSION_STORE, useClass: CachedPermVersionStore },
    { provide: IDENTITY_VERIFICATION_PROVIDER, useClass: MockFaydaProvider },

    // Application services / use cases
    AuthSessionIssuerService,
    RegisterUserCommand,
    VerifyOtpCommand,
    ResendOtpCommand,
    LoginUserCommand,
    RefreshTokenCommand,
    LogoutCommand,
    LogoutAllCommand,
    GetCurrentUserQuery,
    ListSessionsQuery,
    RevokeSessionCommand,
    ListDevicesQuery,
    RevokeDeviceCommand,
    GetLoginHistoryQuery,

    // Profile & lifecycle (§11.5)
    UpdateProfileCommand,
    DeactivateAccountCommand,
    RequestAccountDeletionCommand,

    // Account recovery (§11.3)
    ForgotPasswordCommand,
    ResetPasswordCommand,
    ChangePasswordCommand,

    // RBAC administration (§11.7)
    PermissionChangeService,
    ListRolesQuery,
    ListPermissionsQuery,
    ListUserRolesQuery,
    SetRolePermissionsCommand,
    AssignUserRoleCommand,
    RevokeUserRoleCommand,
    SuspendUserCommand,
    ReactivateUserCommand,

    // Verification / Fayda (§9, §11.6, §11.7)
    SubmitFaydaVerificationCommand,
    SubmitVerificationDocumentsCommand,
    GetVerificationStatusQuery,
    ListVerificationQueueQuery,
    ApproveVerificationCommand,
    RejectVerificationCommand,
    ExpireVerificationsCommand,
    LicenseExpiryJob,

    // Inbound contract for Module 16's verification administration (ADR-002). A facade over the
    // commands above; nothing decides outside the aggregate.
    { provide: IDENTITY_ADMIN_PORT, useClass: IdentityAdminPortAdapter },
    // Inbound read contract for Module 16's operational dashboard (module-16 Work 08): account
    // counts by status and primary role, aggregated in PostgreSQL. No row crosses it.
    { provide: IDENTITY_ANALYTICS_READ_PORT, useClass: PrismaIdentityAnalyticsReadAdapter },

    // Event handlers
    UserRegisteredHandler,

    // Global guards (order matters: JwtAuthGuard populates req.user before PermissionsGuard runs)
    JwtAuthGuard,
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: PermissionsGuard },
  ],
  /**
   * The two contracts a **non-HTTP entry point** needs in order to authenticate the same way a
   * route does (module-01 §8, §12).
   *
   * Nothing was exported before this because nothing needed to be: every entry point in the
   * platform was an HTTP route, and the global `JwtAuthGuard` authenticated all of them without
   * any feature module seeing a token. A WebSocket handshake is the first entry point that is not
   * a request — it carries its bearer token in `handshake.auth` and reaches no guard — so Module
   * 08's tracking gateway has to run those checks itself.
   *
   * Exported rather than reimplemented, and this is the point: the alternative is a second
   * verifier somewhere else, and two places that decide whether a token is valid will eventually
   * disagree about it. `PERM_VERSION_STORE` travels with `TOKEN_SERVICE` because verifying the
   * signature alone is not authentication here — an access token carries a snapshot of its
   * holder's permissions, and without the version comparison a revoked role stays effective until
   * the token expires. On a long-lived socket that is far worse than on a request.
   *
   * Deliberately narrow. No repository, no command, no user data: a consumer can check a token and
   * nothing else.
   *
   * `IDENTITY_ADMIN_PORT` is the second export, added for Module 16's verification queue. It is a
   * contract rather than a repository: the consumer can list and read verification requests as
   * projections (never the Fayda identifier) and can ask this module to approve or reject one —
   * which runs the same commands, the same aggregate rule and the same events as Module 01's own
   * admin controller. `verification_requests` and `users` stay writable from here alone.
   *
   * `IDENTITY_ANALYTICS_READ_PORT` is the third: counts only, for the operational dashboard.
   */
  exports: [TOKEN_SERVICE, PERM_VERSION_STORE, IDENTITY_ADMIN_PORT, IDENTITY_ANALYTICS_READ_PORT],
})
export class IdentityModule {}
