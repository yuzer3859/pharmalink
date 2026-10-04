import { PharmacyInventoryErrors } from '../errors';

export interface OperatingHoursProps {
  weekday: number;
  openTime?: string | null;
  closeTime?: string | null;
  isClosed: boolean;
}

/** `{ weekday: 0..6; openTime?; closeTime?; isClosed }` (module-04 §3.8). */
export class OperatingHours {
  private constructor(readonly props: OperatingHoursProps) {}

  static of(props: OperatingHoursProps): OperatingHours {
    if (!Number.isInteger(props.weekday) || props.weekday < 0 || props.weekday > 6) {
      throw PharmacyInventoryErrors.validation('weekday must be an integer between 0 and 6.', {
        field: 'weekday',
      });
    }
    if (!props.isClosed && props.openTime && props.closeTime) {
      if (props.openTime >= props.closeTime) {
        throw PharmacyInventoryErrors.validation('openTime must be before closeTime.', {
          field: 'openTime',
        });
      }
    }
    return new OperatingHours(props);
  }
}
