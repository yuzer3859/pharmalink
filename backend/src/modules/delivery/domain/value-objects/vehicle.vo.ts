import { DeliveryErrors } from '../errors';

/**
 * `VehicleType` (`architecture/module-08-delivery-tracking.md` §5.2) — what the driver carries
 * medicines in.
 *
 * A closed set, because dispatch will have to reason about it: BRULE-30's cold-chain jobs cannot
 * go to a vehicle with no insulated box, and a bicycle cannot take a bulk order across the city.
 * Free text would make every one of those decisions a comparison against whatever a driver typed.
 *
 * Declared here rather than as a Postgres enum, and the column stays `TEXT`, because this
 * vocabulary is the part of the design most likely to grow — three-wheelers, refrigerated vans,
 * a partner fleet's own categories — and each addition would otherwise be a migration.
 * Validation at the boundary gives the closed set without the ceremony; the repository is the
 * only writer, so nothing else can put an unknown value in the column.
 */
export const VehicleType = {
  Motorcycle: 'MOTORCYCLE',
  Bicycle: 'BICYCLE',
  Car: 'CAR',
  Van: 'VAN',
  OnFoot: 'ON_FOOT',
} as const;

export type VehicleType = (typeof VehicleType)[keyof typeof VehicleType];

const VEHICLE_TYPES: readonly string[] = Object.values(VehicleType);

export function isVehicleType(value: unknown): value is VehicleType {
  return typeof value === 'string' && VEHICLE_TYPES.includes(value);
}

/** Maximum plate length. Ethiopian plates are well inside this; the bound only stops abuse. */
const MAX_PLATE_LENGTH = 32;

/**
 * A driver's vehicle: its type, and the plate it carries where one applies.
 *
 * ## Why the plate is conditional, not merely optional
 *
 * A bicycle and a driver on foot have no plate, and there is no value to record. A motorcycle,
 * car or van has one, and it is the only way a customer or a pharmacy can identify the vehicle
 * that turned up — which is the whole point of recording it. Making it *optional for everyone*
 * would let a van be registered with no plate; making it *required for everyone* would make a
 * bicycle unregisterable. The rule follows the vehicle.
 *
 * The plate is **not** validated against an Ethiopian format. Plate formats differ by region and
 * by vehicle class, diplomatic and government series follow their own patterns, and a pattern
 * that is merely nearly right would lock out real drivers with real vehicles — a much worse
 * failure than storing a typo an operator can correct.
 */
export class Vehicle {
  private constructor(
    readonly type: VehicleType,
    readonly plateNumber: string | null,
  ) {}

  static of(type: string, plateNumber?: string | null): Vehicle {
    if (!isVehicleType(type)) {
      throw DeliveryErrors.validation(
        `vehicleType must be one of: ${VEHICLE_TYPES.join(', ')}.`,
        { field: 'vehicleType', allowed: VEHICLE_TYPES },
      );
    }

    const plate = typeof plateNumber === 'string' ? plateNumber.trim() : '';
    const requiresPlate = type !== VehicleType.Bicycle && type !== VehicleType.OnFoot;

    if (requiresPlate && plate.length === 0) {
      throw DeliveryErrors.validation(`A ${type} must have a plate number.`, {
        field: 'plateNumber',
        vehicleType: type,
      });
    }
    if (!requiresPlate && plate.length > 0) {
      throw DeliveryErrors.validation(`A ${type} has no plate number.`, {
        field: 'plateNumber',
        vehicleType: type,
      });
    }
    if (plate.length > MAX_PLATE_LENGTH) {
      throw DeliveryErrors.validation(
        `plateNumber must be at most ${MAX_PLATE_LENGTH} characters.`,
        { field: 'plateNumber' },
      );
    }

    return new Vehicle(type, plate.length > 0 ? plate : null);
  }

  /**
   * Rebuilds from two independently nullable columns, returning `null` when no vehicle is
   * recorded. A stored type that is no longer in the closed set, or a stored pair the rules above
   * would now reject, also yields `null` rather than throwing: see `ServiceArea.fromJson` for the
   * same reasoning — a profile must load so that it can be corrected.
   */
  static fromColumns(type: string | null, plateNumber: string | null): Vehicle | null {
    if (type === null) {
      return null;
    }
    try {
      return Vehicle.of(type, plateNumber);
    } catch {
      return null;
    }
  }

  equals(other: Vehicle): boolean {
    return this.type === other.type && this.plateNumber === other.plateNumber;
  }
}
