import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { PharmacyRegistrationService } from '../../application/services/pharmacy-registration.service';
import { RegisterPharmacyForOwnerDto, RequestOwnerLicenceUploadDto } from '../dtos/pharmacy-registration.dto';

/**
 * Work 154: the Super Admin registers a pharmacy for an owner.
 *
 *     POST /admin/pharmacy-registrations/uploads   a signed upload for one licence file, stored under the owner
 *     POST /admin/pharmacy-registrations           organisation, licence (approved), storefront, activation
 *
 * `provider:verify:any` — the key that approves licences and activates pharmacies, which this does
 * in one step. The owner is an existing, active, e-mail-verified account (found by e-mail in the
 * portal); a new owner signs up first, as pharmacy staff do, since there is no invitation e-mail.
 */
@Controller('admin/pharmacy-registrations')
@RequirePermissions('provider:verify:any')
export class AdminPharmacyRegistrationController {
  constructor(private readonly registrations: PharmacyRegistrationService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  upload(@Body() dto: RequestOwnerLicenceUploadDto, @Req() req: Request) {
    return this.registrations.requestUpload({ ownerUserId: dto.ownerUserId, contentType: dto.contentType, bytes: dto.bytes, ip: req.ip ?? null });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  register(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: RegisterPharmacyForOwnerDto, @Req() req: Request) {
    return this.registrations.register({ actorUserId: user.userId, ...dto, ip: req.ip ?? null });
  }
}
