import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ProviderRegistrationService } from '../../application/services/provider-registration.service';
import {
  ListProvidersQueryDto,
  RegisterProviderDto,
  RequestFacilityLicenceUploadDto,
  SuspendProviderDto,
} from '../dtos/provider-registration.dto';

/**
 * Work 160: the Super Admin registers hospitals, clinics, diagnostic centres and labs for their
 * administrators (Module 09).
 *
 *     POST /admin/provider-registrations/uploads   a signed upload for one licence file, stored under the administrator
 *     POST /admin/provider-registrations           organisation, facility licence (approved), profile, activation
 *
 * `provider:verify:any`, the key that approves licences, which this does in one step. The
 * administrator is an existing, active, e-mail-verified customer account (found by e-mail or phone
 * in the portal); a new one signs up in the app first, as there is no invitation e-mail.
 */
@Controller('admin/provider-registrations')
@RequirePermissions('provider:verify:any')
export class AdminProviderRegistrationController {
  constructor(private readonly registrations: ProviderRegistrationService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  upload(@Body() dto: RequestFacilityLicenceUploadDto, @Req() req: Request) {
    return this.registrations.requestUpload({ adminUserId: dto.adminUserId, contentType: dto.contentType, bytes: dto.bytes, ip: req.ip ?? null });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  register(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: RegisterProviderDto, @Req() req: Request) {
    return this.registrations.register({ actorUserId: user.userId, ...dto, ip: req.ip ?? null });
  }
}

/**
 * Work 160: the Super Admin's healthcare provider records (module-09 §8.3).
 *
 *     GET  /admin/providers                 by name, type and status, newest first
 *     GET  /admin/providers/:id             the record: profile, locations, departments, services, organisation and licence
 *     POST /admin/providers/:id/suspend     { reason } — stops it operating at once
 *     POST /admin/providers/:id/reactivate  again, if its licence is still approved and current
 */
@Controller('admin/providers')
export class AdminProvidersController {
  constructor(private readonly registrations: ProviderRegistrationService) {}

  @Get()
  @RequirePermissions('provider:read:any')
  list(@Query() dto: ListProvidersQueryDto) {
    const page = dto.page ?? 1;
    const size = dto.size ?? 20;
    return this.registrations.list({ q: dto.q, type: dto.type, status: dto.status }, page, size).then((r) => ({ ...r, page, size }));
  }

  @Get(':providerId')
  @RequirePermissions('provider:read:any')
  get(@Param('providerId', new ParseUUIDPipe()) providerId: string) {
    return this.registrations.get(providerId);
  }

  @Post(':providerId/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('provider:verify:any')
  suspend(@CurrentUser() user: AuthenticatedPrincipal, @Param('providerId', new ParseUUIDPipe()) providerId: string, @Body() dto: SuspendProviderDto) {
    return this.registrations.suspend({ actorUserId: user.userId, providerId, reason: dto.reason });
  }

  @Post(':providerId/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('provider:verify:any')
  reactivate(@CurrentUser() user: AuthenticatedPrincipal, @Param('providerId', new ParseUUIDPipe()) providerId: string) {
    return this.registrations.reactivate({ actorUserId: user.userId, providerId });
  }
}
