import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { DriverRegistrationService } from '../../application/services/driver-registration.service';
import { RegisterDriverDto, RequestDriverUploadDto } from '../dtos/driver-registration.dto';

/**
 * Work 156: the Super Admin registers and looks after drivers.
 *
 *     POST /admin/drivers/uploads          a signed upload for one document, stored under the person   provider:verify:any
 *     POST /admin/drivers                  make them a driver, approve their documents, create the profile provider:verify:any
 *     GET  /admin/drivers/:userId/profile  vehicle, plate, service area, availability (never location)  driver:read:any
 *
 * The driver list is `GET /admin/accounts?primaryRole=DRIVER`; their documents are
 * `GET /admin/verifications?userId=…&type=DRIVER_DOCS`; disabling is suspending the account.
 */
@Controller('admin/drivers')
export class AdminDriversController {
  constructor(private readonly drivers: DriverRegistrationService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('provider:verify:any')
  upload(@Body() dto: RequestDriverUploadDto, @Req() req: Request) {
    return this.drivers.requestUpload({ userId: dto.userId, contentType: dto.contentType, bytes: dto.bytes, ip: req.ip ?? null });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('provider:verify:any')
  async register(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: RegisterDriverDto, @Req() req: Request) {
    const { userId, profile } = await this.drivers.register({
      actorUserId: user.userId,
      userId: dto.userId,
      vehicleType: dto.vehicleType,
      plateNumber: dto.plateNumber ?? null,
      documentsExpireOn: dto.documentsExpireOn,
      documents: dto.documents,
      serviceArea: dto.serviceArea ?? null,
      ip: req.ip ?? null,
    });
    return { userId, profile: toProfileResponse(profile) };
  }

  @Get(':userId/profile')
  @RequirePermissions('driver:read:any')
  async profile(@Param('userId', new ParseUUIDPipe()) userId: string) {
    const profile = await this.drivers.profileOf(userId);
    if (!profile) throw new NotFoundException('This account has no driver profile.');
    return toProfileResponse(profile);
  }
}

function toProfileResponse(p: NonNullable<Awaited<ReturnType<DriverRegistrationService['profileOf']>>>) {
  return {
    driverProfileId: p.driverProfileId,
    vehicleType: p.vehicleType,
    plateNumber: p.plateNumber,
    serviceArea: p.serviceArea,
    availability: p.availability,
    shiftStartedAt: p.shiftStartedAt?.toISOString() ?? null,
    lastOnlineAt: p.lastOnlineAt?.toISOString() ?? null,
    maxConcurrent: p.maxConcurrent,
    createdAt: p.createdAt.toISOString(),
  };
}
