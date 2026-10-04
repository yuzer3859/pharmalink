import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ApprovePrescriptionCommand } from '../../application/commands/approve-prescription.command';
import { RejectPrescriptionCommand } from '../../application/commands/reject-prescription.command';
import { RequestClarificationCommand } from '../../application/commands/request-clarification.command';
import { GetPrescriptionQuery } from '../../application/queries/get-prescription.query';
import { GetVerificationQueueQuery } from '../../application/queries/get-verification-queue.query';
import { ResolveCallerVerificationOrgQuery } from '../../application/queries/resolve-caller-verification-org.query';
import {
  ApprovePrescriptionDto,
  RejectPrescriptionDto,
  RequestClarificationDto,
  VerificationQueueQueryDto,
} from '../dtos/verification.dto';

/**
 * Pharmacist verification queue (`prescription:verify`, module-05 §10.2, §7.3). Wrong-org/self-
 * review rejection is `VerificationPolicy`'s job (`ApprovePrescriptionCommand`/
 * `RejectPrescriptionCommand`/`RequestClarificationCommand` already enforce it via
 * `IIdentityPort.hasRoleAtOrganization()`) — this controller never re-implements that check.
 * `queue` is the one route that needs the caller's own verifying-pharmacy organization resolved
 * first (mirrors Module 04's `ResolveCallerPharmacyQuery` pattern), since
 * `GetVerificationQueueQuery` takes an already-resolved `verifyingPharmacyId`.
 */
@Controller('pharmacy/verification')
export class VerificationController {
  constructor(
    private readonly resolveCallerVerificationOrg: ResolveCallerVerificationOrgQuery,
    private readonly getVerificationQueue: GetVerificationQueueQuery,
    private readonly getPrescription: GetPrescriptionQuery,
    private readonly approvePrescription: ApprovePrescriptionCommand,
    private readonly rejectPrescription: RejectPrescriptionCommand,
    private readonly requestClarification: RequestClarificationCommand,
  ) {}

  @Get('queue')
  @RequirePermissions('prescription:verify')
  async queue(@CurrentUser() user: AuthenticatedPrincipal, @Query() query: VerificationQueueQueryDto) {
    const verifyingPharmacyId = await this.resolveCallerVerificationOrg.execute(user.userId);
    return this.getVerificationQueue.execute({
      verifyingPharmacyId,
      page: query.page ?? 1,
      size: query.size ?? 20,
    });
  }

  @Get(':id')
  @RequirePermissions('prescription:verify')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.getPrescription.execute({ prescriptionId: id, requestingUserId: user.userId });
  }

  @Post(':id/approve')
  @RequirePermissions('prescription:verify')
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: ApprovePrescriptionDto,
  ) {
    return this.approvePrescription.execute({
      prescriptionId: id,
      reviewerUserId: user.userId,
      lines: dto.lines,
      legibilityOk: dto.legibilityOk,
      validityOk: dto.validityOk,
    });
  }

  @Post(':id/reject')
  @RequirePermissions('prescription:verify')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: RejectPrescriptionDto,
  ) {
    return this.rejectPrescription.execute({
      prescriptionId: id,
      reviewerUserId: user.userId,
      reason: dto.reason,
    });
  }

  @Post(':id/clarify')
  @RequirePermissions('prescription:verify')
  @HttpCode(HttpStatus.OK)
  clarify(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: RequestClarificationDto,
  ) {
    return this.requestClarification.execute({
      prescriptionId: id,
      reviewerUserId: user.userId,
      message: dto.message,
    });
  }
}
