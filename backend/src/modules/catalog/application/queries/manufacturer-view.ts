import { Manufacturer } from '../../domain/entities/manufacturer.entity';

export interface ManufacturerView {
  id: string;
  name: string;
  country: string | null;
  status: string | null;
  createdAt: Date;
}

export function toManufacturerView(manufacturer: Manufacturer): ManufacturerView {
  const props = manufacturer.toProps();
  return {
    id: props.id,
    name: props.name,
    country: props.country,
    status: props.status,
    createdAt: props.createdAt,
  };
}
