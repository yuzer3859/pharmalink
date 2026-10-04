import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { GeoPoint } from './geo-point.vo';
import {
  MAX_SERVICE_RADIUS_METERS,
  MIN_SERVICE_RADIUS_METERS,
  ServiceArea,
} from './service-area.vo';
import { Vehicle, VehicleType } from './vehicle.vo';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as ApiException).code;
  }
  throw new Error('expected a throw');
}

const ADDIS = GeoPoint.of(9.03, 38.74);

describe('ServiceArea', () => {
  it('holds a centre and a radius', () => {
    const area = ServiceArea.of(ADDIS, 5_000);
    expect(area.center.equals(ADDIS)).toBe(true);
    expect(area.radiusMeters).toBe(5_000);
  });

  it('rejects a radius outside the sanity bounds', () => {
    expect(codeOf(() => ServiceArea.of(ADDIS, MIN_SERVICE_RADIUS_METERS - 1))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    // The typo guard: a driver who meant 5 km and typed 5000000 would otherwise be offered every
    // job on the platform.
    expect(codeOf(() => ServiceArea.of(ADDIS, MAX_SERVICE_RADIUS_METERS + 1))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('rejects a fractional radius', () => {
    expect(codeOf(() => ServiceArea.of(ADDIS, 5_000.5))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('round-trips through JSON', () => {
    const area = ServiceArea.of(ADDIS, 7_500);
    const back = ServiceArea.fromJson(area.toJson());
    expect(back?.equals(area)).toBe(true);
  });

  describe('fromJson', () => {
    it.each([
      ['null', null],
      ['an array', [1, 2]],
      ['a string', 'Bole'],
      ['a missing radius', { lat: 9, lng: 38 }],
      ['a non-numeric radius', { lat: 9, lng: 38, radiusMeters: '5000' }],
      ['an out-of-range coordinate', { lat: 999, lng: 38, radiusMeters: 5_000 }],
      ['an out-of-range radius', { lat: 9, lng: 38, radiusMeters: 1 }],
    ])('returns null for %s rather than throwing', (_label, value) => {
      // A `Json` column has no compile-time shape. A driver whose area is unreadable is one
      // dispatch will not consider — visible and correctable — where a throw would take the
      // whole profile read down with it.
      expect(ServiceArea.fromJson(value)).toBeNull();
    });
  });
});

describe('Vehicle', () => {
  it('accepts a plated vehicle with its plate', () => {
    const vehicle = Vehicle.of(VehicleType.Motorcycle, 'AA-12345');
    expect(vehicle.type).toBe(VehicleType.Motorcycle);
    expect(vehicle.plateNumber).toBe('AA-12345');
  });

  it('accepts an unplated vehicle with no plate', () => {
    expect(Vehicle.of(VehicleType.Bicycle).plateNumber).toBeNull();
    expect(Vehicle.of(VehicleType.OnFoot, null).plateNumber).toBeNull();
  });

  it('refuses a vehicle type outside the closed set', () => {
    expect(codeOf(() => Vehicle.of('HOVERCRAFT', 'AA-1'))).toBe(ErrorCode.VALIDATION_ERROR);
    // Case matters: dispatch compares against the constant, not against what a driver typed.
    expect(codeOf(() => Vehicle.of('motorcycle', 'AA-1'))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('requires a plate where the vehicle has one', () => {
    for (const type of [VehicleType.Motorcycle, VehicleType.Car, VehicleType.Van]) {
      expect(codeOf(() => Vehicle.of(type))).toBe(ErrorCode.VALIDATION_ERROR);
      expect(codeOf(() => Vehicle.of(type, '   '))).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });

  it('refuses a plate where the vehicle has none', () => {
    expect(codeOf(() => Vehicle.of(VehicleType.Bicycle, 'AA-1'))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('trims the plate', () => {
    expect(Vehicle.of(VehicleType.Car, '  AA-1  ').plateNumber).toBe('AA-1');
  });

  it('does not impose an Ethiopian plate format', () => {
    // Formats differ by region and vehicle class; a nearly-right pattern would lock out real
    // drivers with real vehicles, which is worse than a typo an operator can correct.
    expect(Vehicle.of(VehicleType.Van, '3-A12345 ET').plateNumber).toBe('3-A12345 ET');
  });

  describe('fromColumns', () => {
    it('returns null when no vehicle is recorded', () => {
      expect(Vehicle.fromColumns(null, null)).toBeNull();
    });

    it('returns null for a stored type no longer in the closed set', () => {
      expect(Vehicle.fromColumns('HOVERCRAFT', 'AA-1')).toBeNull();
    });

    it('returns null for a stored pair the rules now reject', () => {
      expect(Vehicle.fromColumns(VehicleType.Car, null)).toBeNull();
    });

    it('rebuilds a valid pair', () => {
      expect(Vehicle.fromColumns(VehicleType.Car, 'AA-1')?.plateNumber).toBe('AA-1');
    });
  });
});
