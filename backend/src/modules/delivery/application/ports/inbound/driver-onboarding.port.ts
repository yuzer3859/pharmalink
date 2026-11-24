import { Inject, Injectable } from '@nestjs/common';
import { CreateDriverProfileCommand } from '../../commands/create-driver-profile.command';
import { DRIVER_PROFILE_REPOSITORY, IDriverProfileRepository } from '../../../domain/repositories/driver-profile.repository';

export const DRIVER_ONBOARDING_PORT = Symbol('DRIVER_ONBOARDING_PORT');

export interface DriverProfileRecord {
  driverProfileId: string;
  vehicleType: string | null;
  plateNumber: string | null;
  serviceArea: { lat: number; lng: number; radiusMeters: number } | null;
  availability: string;
  shiftStartedAt: Date | null;
  lastOnlineAt: Date | null;
  maxConcurrent: number | null;
  createdAt: Date;
}

/**
 * Work 156: the delivery side of registering a driver, for a platform administrator. `createProfile`
 * is `CreateDriverProfileCommand` (one profile per driver: a second call returns the first);
 * `profileOf` is the driver's profile for the Super Admin's record — vehicle, plate, service area
 * and availability, never their location.
 */
export interface IDriverOnboardingPort {
  createProfile(input: {
    userId: string;
    actorUserId: string;
    vehicleType: string;
    plateNumber: string | null;
    serviceArea: { lat: number; lng: number; radiusMeters: number } | null;
  }): Promise<DriverProfileRecord>;
  profileOf(userId: string): Promise<DriverProfileRecord | null>;
}

@Injectable()
export class DriverOnboardingAdapter implements IDriverOnboardingPort {
  constructor(
    private readonly create: CreateDriverProfileCommand,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
  ) {}

  async createProfile(input: {
    userId: string;
    actorUserId: string;
    vehicleType: string;
    plateNumber: string | null;
    serviceArea: { lat: number; lng: number; radiusMeters: number } | null;
  }): Promise<DriverProfileRecord> {
    await this.create.execute({
      userId: input.userId,
      vehicleType: input.vehicleType,
      plateNumber: input.plateNumber,
      serviceArea: input.serviceArea,
      actorUserId: input.actorUserId,
    });
    return (await this.profileOf(input.userId))!;
  }

  async profileOf(userId: string): Promise<DriverProfileRecord | null> {
    const p = await this.profiles.findByUserId(userId);
    if (!p) return null;
    return {
      driverProfileId: p.id,
      vehicleType: p.vehicle?.type ?? null,
      plateNumber: p.vehicle?.plateNumber ?? null,
      serviceArea: p.serviceArea ? { lat: p.serviceArea.center.lat, lng: p.serviceArea.center.lng, radiusMeters: p.serviceArea.radiusMeters } : null,
      availability: p.availability,
      shiftStartedAt: p.shiftStartedAt,
      lastOnlineAt: p.lastOnlineAt,
      maxConcurrent: p.maxConcurrent,
      createdAt: p.createdAt,
    };
  }
}
