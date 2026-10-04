import { AddressLabel } from '../enums';
import { ProfileErrors } from '../errors';
import { GeoPoint } from '../value-objects/geo-point';

export interface AddressProps {
  id: string;
  userId: string;
  label: AddressLabel;
  recipientName: string;
  recipientPhone: string;
  region: string | null;
  city: string | null;
  subcity: string | null;
  woreda: string | null;
  landmark: string | null;
  addressLine: string | null;
  lat: number;
  lng: number;
  isDefault: boolean;
  isWithinEthiopia: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Fields required to create a brand-new address (module-02 §4.2). */
export interface NewAddressProps {
  label?: AddressLabel;
  recipientName: string;
  recipientPhone: string;
  region?: string | null;
  city?: string | null;
  subcity?: string | null;
  woreda?: string | null;
  landmark?: string | null;
  addressLine?: string | null;
  lat: number;
  lng: number;
}

/** Fields `UpdateAddressCommand` may change (module-02 §4.2, all optional/PATCH). */
export interface AddressEdits {
  label?: AddressLabel;
  recipientName?: string;
  recipientPhone?: string;
  region?: string | null;
  city?: string | null;
  subcity?: string | null;
  woreda?: string | null;
  landmark?: string | null;
  addressLine?: string | null;
  lat?: number;
  lng?: number;
}

/**
 * Address entity, owned by a user (module-02 §3.2). Framework-free. `beneficiaryId` is always
 * null in this slice (beneficiaries don't exist yet, out of scope §1.2) so it is intentionally
 * absent from these props — the Prisma adapter writes it as `null` at the persistence boundary.
 */
export class Address {
  private constructor(private props: AddressProps) {}

  static rehydrate(props: AddressProps): Address {
    return new Address(props);
  }

  /**
   * Creates a new address, enforcing the "at least one locator" rule and the Ethiopia geofence
   * (BRULE-21). Coordinates that fail the geofence are rejected outright — never persisted with
   * `isWithinEthiopia: false` (module-02 §3.2 invariant 5, §14 Q2 resolved in favor of rejection).
   */
  static create(id: string, userId: string, input: NewAddressProps, now: Date = new Date()): Address {
    Address.assertHasLocator(input.region ?? null, input.city ?? null, input.addressLine ?? null);
    if (!GeoPoint.withinEthiopia(input.lat, input.lng)) {
      throw ProfileErrors.outsideEthiopia();
    }

    return new Address({
      id,
      userId,
      label: input.label ?? AddressLabel.HOME,
      recipientName: input.recipientName,
      recipientPhone: input.recipientPhone,
      region: input.region ?? null,
      city: input.city ?? null,
      subcity: input.subcity ?? null,
      woreda: input.woreda ?? null,
      landmark: input.landmark ?? null,
      addressLine: input.addressLine ?? null,
      lat: input.lat,
      lng: input.lng,
      isDefault: false,
      isWithinEthiopia: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get isDefault(): boolean {
    return this.props.isDefault;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }

  /** Applies a PATCH edit set, re-validating the locator rule and geofence as needed. */
  applyEdits(edits: AddressEdits, now: Date = new Date()): string[] {
    const changed: string[] = [];
    const next = { ...this.props };

    if (edits.label !== undefined) {
      next.label = edits.label;
      changed.push('label');
    }
    if (edits.recipientName !== undefined) {
      next.recipientName = edits.recipientName;
      changed.push('recipientName');
    }
    if (edits.recipientPhone !== undefined) {
      next.recipientPhone = edits.recipientPhone;
      changed.push('recipientPhone');
    }
    if (edits.region !== undefined) {
      next.region = edits.region;
      changed.push('region');
    }
    if (edits.city !== undefined) {
      next.city = edits.city;
      changed.push('city');
    }
    if (edits.subcity !== undefined) {
      next.subcity = edits.subcity;
      changed.push('subcity');
    }
    if (edits.woreda !== undefined) {
      next.woreda = edits.woreda;
      changed.push('woreda');
    }
    if (edits.landmark !== undefined) {
      next.landmark = edits.landmark;
      changed.push('landmark');
    }
    if (edits.addressLine !== undefined) {
      next.addressLine = edits.addressLine;
      changed.push('addressLine');
    }
    if (edits.lat !== undefined) {
      next.lat = edits.lat;
      changed.push('lat');
    }
    if (edits.lng !== undefined) {
      next.lng = edits.lng;
      changed.push('lng');
    }

    if (changed.length === 0) {
      return changed;
    }

    Address.assertHasLocator(next.region, next.city, next.addressLine);
    if (edits.lat !== undefined || edits.lng !== undefined) {
      if (!GeoPoint.withinEthiopia(next.lat, next.lng)) {
        throw ProfileErrors.outsideEthiopia();
      }
    }

    next.updatedAt = now;
    this.props = next;
    return changed;
  }

  /** §4.2: at least one of `{region+city}` or `addressLine` must be present to be deliverable. */
  private static assertHasLocator(
    region: string | null,
    city: string | null,
    addressLine: string | null,
  ): void {
    const hasRegionCity = Boolean(region) && Boolean(city);
    const hasAddressLine = Boolean(addressLine);
    if (!hasRegionCity && !hasAddressLine) {
      throw ProfileErrors.validation(
        'Provide a region and city, or an address line, so the address is deliverable.',
        { field: 'addressLine' },
      );
    }
  }

  markDefault(now: Date = new Date()): void {
    this.props.isDefault = true;
    this.props.updatedAt = now;
  }

  /**
   * Unsetting the only/current default without a replacement is rejected — a user cannot leave
   * themselves defaultless while addresses remain (module-02 §8.2, edge case 11).
   */
  clearDefault(): void {
    if (!this.props.isDefault) {
      return;
    }
    throw ProfileErrors.defaultAddressRequired();
  }

  /** Used internally by SetDefaultAddressCommand/DeleteAddressCommand, which own the swap. */
  forceClearDefault(now: Date = new Date()): void {
    this.props.isDefault = false;
    this.props.updatedAt = now;
  }

  softDelete(now: Date = new Date()): void {
    this.props.deletedAt = now;
    this.props.updatedAt = now;
  }

  toProps(): Readonly<AddressProps> {
    return { ...this.props };
  }
}
