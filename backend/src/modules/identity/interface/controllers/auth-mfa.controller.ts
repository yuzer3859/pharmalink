import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SensitiveRateLimit } from '../../../../shared/http/rate-limit.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { ConfirmMfaEnrollmentCommand } from '../../application/commands/confirm-mfa-enrollment.command';
import { RedeemMfaRecoveryCodeCommand } from '../../application/commands/redeem-mfa-recovery-code.command';
import { RotateMfaRecoveryCodesCommand } from '../../application/commands/rotate-mfa-recovery-codes.command';
import { StartMfaEnrollmentCommand } from '../../application/commands/start-mfa-enrollment.command';
import { VerifyMfaChallengeCommand } from '../../application/commands/verify-mfa-challenge.command';
import { GetMfaStatusQuery } from '../../application/queries/get-mfa-status.query';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import {
  ConfirmMfaEnrollmentDto,
  MfaChallengeDto,
  RedeemMfaRecoveryCodeDto,
  RotateMfaRecoveryCodesDto,
  VerifyMfaChallengeDto,
} from '../dtos/mfa.dto';

/**
 * Administrator MFA (Work 66, backend/docs/admin-mfa.md).
 *
 * The four challenge routes are `@Public()` because the caller has no access token yet: what
 * authorizes them is the challenge token from `POST /auth/login`, which is bound to one account and
 * one purpose and can do nothing else. All of them use the sensitive-endpoint rate limit. Status and
 * recovery-code rotation need a normal (MFA-verified) access token.
 */
@Controller('auth/mfa')
export class AuthMfaController {
  constructor(
    private readonly startEnrollment: StartMfaEnrollmentCommand,
    private readonly confirmEnrollment: ConfirmMfaEnrollmentCommand,
    private readonly verifyChallenge: VerifyMfaChallengeCommand,
    private readonly redeemRecoveryCode: RedeemMfaRecoveryCodeCommand,
    private readonly rotateRecoveryCodes: RotateMfaRecoveryCodesCommand,
    private readonly getStatus: GetMfaStatusQuery,
  ) {}

  /** ENROLL challenge → authenticator provisioning details (secret, otpauth URI). */
  @Public()
  @SensitiveRateLimit()
  @Post('enrollment/start')
  @HttpCode(HttpStatus.OK)
  start(@Body() dto: MfaChallengeDto, @Req() req: Request) {
    return this.startEnrollment.execute({ ...dto, ...context(req) });
  }

  /** ENROLL challenge + first code → MFA-verified session and one-time recovery codes. */
  @Public()
  @SensitiveRateLimit()
  @Post('enrollment/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Body() dto: ConfirmMfaEnrollmentDto, @Req() req: Request) {
    return this.confirmEnrollment.execute({ ...dto, ...context(req) });
  }

  /** TOTP challenge + authenticator code → MFA-verified session. */
  @Public()
  @SensitiveRateLimit()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(@Body() dto: VerifyMfaChallengeDto, @Req() req: Request) {
    return this.verifyChallenge.execute({ ...dto, ...context(req) });
  }

  /** TOTP challenge + recovery code → a replacement-enrolment challenge (never a session). */
  @Public()
  @SensitiveRateLimit()
  @Post('recovery')
  @HttpCode(HttpStatus.OK)
  recover(@Body() dto: RedeemMfaRecoveryCodeDto, @Req() req: Request) {
    return this.redeemRecoveryCode.execute({ ...dto, ...context(req) });
  }

  @Get('status')
  status(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.getStatus.execute(user.userId);
  }

  @SensitiveRateLimit()
  @Post('recovery-codes/rotate')
  @HttpCode(HttpStatus.OK)
  rotate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: RotateMfaRecoveryCodesDto,
    @Req() req: Request,
  ) {
    return this.rotateRecoveryCodes.execute({ userId: user.userId, code: dto.code, ip: req.ip ?? null });
  }
}

function context(req: Request): { ip: string | null; userAgent: string | null } {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}
