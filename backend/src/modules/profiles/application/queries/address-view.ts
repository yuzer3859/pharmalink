import { Address } from '../../domain/entities/address.entity';

/** Shape returned by every address endpoint (module-02 §8.2). `beneficiaryId`/`isWithinEthiopia`
 * are intentionally not exposed — the former is always null this slice, the latter is an
 * internal server-computed detail (addresses that fail the geofence are rejected, not stored). */
export interface AddressView {
  id: string;
  label: string;
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
  createdAt: Date;
  updatedAt: Date;
}

export function toAddressView(address: Address): AddressView {
  const props = address.toProps();
  return {
    id: props.id,
    label: props.label,
    recipientName: props.recipientName,
    recipientPhone: props.recipientPhone,
    region: props.region,
    city: props.city,
    subcity: props.subcity,
    woreda: props.woreda,
    landmark: props.landmark,
    addressLine: props.addressLine,
    lat: props.lat,
    lng: props.lng,
    isDefault: props.isDefault,
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}
