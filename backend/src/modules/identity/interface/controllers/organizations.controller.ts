import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { ApplyPharmacyOrganizationCommand } from '../../application/commands/apply-pharmacy-organization.command';
import { CurrentUser } from '../decorators/current-user.decorator';
import { ApplyPharmacyOrganizationDto } from '../dtos/organization.dto';

/**
 * Organisation onboarding (Work 65). Authenticated, never `@Public()`. The owner is always the
 * caller (`@CurrentUser()`); nothing about ownership, type, status or roles comes from the client.
 */
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly applyPharmacy: ApplyPharmacyOrganizationCommand) {}

  @Post('pharmacy')
  @RequirePermissions('pharmacy:apply:own')
  pharmacy(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: ApplyPharmacyOrganizationDto,
    @Req() req: Request,
  ) {
    return this.applyPharmacy.execute({
      actorUserId: user.userId,
      legalName: dto.legalName,
      idempotencyKey: dto.idempotencyKey,
      ip: req.ip ?? null,
    });
  }
}
