import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, Max, Min } from 'class-validator';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ManageDriverShiftCommand } from '../../application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../../application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../../application/commands/update-driver-location.command';
import { IDENTITY_PORT, IIdentityPort } from '../../application/ports/outbound/identity.port';
import { DriverProfileProps } from '../../domain/entities/driver-profile.entity';
import { DriverAvailability } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import { DRIVER_PROFILE_REPOSITORY, IDriverProfileRepository } from '../../domain/repositories/driver-profile.repository';

export class SetAvailabilityDto {
  @IsIn([DriverAvailability.ONLINE, DriverAvailability.OFFLINE])
  status!: DriverAvailability;
}

export class DriverLocationDto {
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}

/** A location report closer than this to the last applied one is acknowledged and not written. */
export const LOCATION_MIN_INTERVAL_MS = 3_000;

export interface DriverProfileResponse {
  userId: string;
  availability: DriverAvailability;
  onShift: boolean;
  shiftStartedAt: Date | null;
  vehicle: { type: string; plateNumber: string | null } | null;
  serviceArea: { lat: number; lng: number; radiusMeters: number } | null;
  maxConcurrent: number | null;
  lastLocation: { lat: number; lng: number; at: Date | null } | null;
  verification: { isEligible: boolean; reason: string | null; documentsExpireAt: Date | null };
}

function toResponse(profile: DriverProfileProps, identity: { isEligible: boolean; reason: string | null; documentsExpireAt: Date | null }): DriverProfileResponse {
  return {
    userId: profile.userId,
    availability: profile.availability,
    onShift: profile.shiftStartedAt !== null,
    shiftStartedAt: profile.shiftStartedAt,
    vehicle: profile.vehicle ? { type: profile.vehicle.type, plateNumber: profile.vehicle.plateNumber } : null,
    serviceArea: profile.serviceArea ? { lat: profile.serviceArea.center.lat, lng: profile.serviceArea.center.lng, radiusMeters: profile.serviceArea.radiusMeters } : null,
    maxConcurrent: profile.maxConcurrent,
    lastLocation: profile.lastLocation ? { lat: profile.lastLocation.lat, lng: profile.lastLocation.lng, at: profile.lastLocationAt } : null,
    verification: { isEligible: identity.isEligible, reason: identity.reason, documentsExpireAt: identity.documentsExpireAt },
  };
}

/**
 * Work 117: the driver's own operational routes (module-08 §9.1) for the driver app, over the
 * commands that already exist. Always the token's own driver; nothing in a request names a driver.
 *
 *   GET  /driver/profile        the driver's profile, shift, availability and BRULE-09 verification state
 *   PUT  /driver/availability   { status: ONLINE | OFFLINE }  going online starts the shift first;
 *                               going offline ends it. Online needs a verified driver (the command's rule).
 *   POST /delivery/location     { lat, lng }  the driver's position, which dispatch ranks by. Reports
 *                               closer than 3 s apart are acknowledged and not written.
 */
@Controller()
export class DriverSelfController {
  constructor(
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    private readonly availability: SetDriverAvailabilityCommand,
    private readonly shift: ManageDriverShiftCommand,
    private readonly location: UpdateDriverLocationCommand,
  ) {}

  @Get('driver/profile')
  @RequirePermissions('delivery:read:own')
  async profile(@CurrentUser() user: AuthenticatedPrincipal): Promise<DriverProfileResponse> {
    return this.read(user.userId);
  }

  @Put('driver/availability')
  @RequirePermissions('delivery:update:own')
  async setAvailability(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: SetAvailabilityDto): Promise<DriverProfileResponse> {
    if (dto.status === DriverAvailability.ONLINE) {
      await this.shift.start({ userId: user.userId });
      await this.availability.execute({ userId: user.userId, availability: DriverAvailability.ONLINE });
    } else {
      await this.availability.execute({ userId: user.userId, availability: DriverAvailability.OFFLINE });
      await this.shift.end({ userId: user.userId });
    }
    return this.read(user.userId);
  }

  @Post('delivery/location')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('delivery:update:own')
  async reportLocation(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: DriverLocationDto): Promise<{ applied: boolean; throttled: boolean }> {
    const profile = await this.profiles.findByUserId(user.userId);
    if (!profile) throw DeliveryErrors.driverProfileNotFound({ userId: user.userId });
    if (profile.lastLocationAt && Date.now() - profile.lastLocationAt.getTime() < LOCATION_MIN_INTERVAL_MS) {
      return { applied: false, throttled: true };
    }
    const result = await this.location.execute({ userId: user.userId, lat: dto.lat, lng: dto.lng });
    return { applied: result.applied, throttled: false };
  }

  private async read(userId: string): Promise<DriverProfileResponse> {
    const profile = await this.profiles.findByUserId(userId);
    if (!profile) throw DeliveryErrors.driverProfileNotFound({ userId });
    const identity = await this.identity.getDriverIdentity(userId);
    return toResponse(profile, identity);
  }
}
