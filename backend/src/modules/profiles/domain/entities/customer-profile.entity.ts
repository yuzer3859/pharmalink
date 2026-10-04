import { Gender } from '../enums';
import { ProfileErrors } from '../errors';

export interface CustomerProfileProps {
  id: string;
  userId: string;
  fullName: string | null;
  gender: Gender | null;
  dateOfBirth: Date | null;
  secondaryPhone: string | null;
  timezone: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Fields `UpdateProfileCommand` may change (module-02 §3.1, §4.1). */
export interface CustomerProfileEdits {
  fullName?: string;
  gender?: Gender;
  dateOfBirth?: Date;
  secondaryPhone?: string | null;
  timezone?: string;
}

const MAX_AGE_YEARS = 120;

/**
 * CustomerProfile aggregate root, 1:1 with a `User` (module-02 §3.1). Framework-free: no
 * Prisma/Nest imports. `userId` is a plain string, not a Prisma relation (ADR-002 — no
 * cross-module table reads/relations).
 */
export class CustomerProfile {
  private constructor(private props: CustomerProfileProps) {}

  static rehydrate(props: CustomerProfileProps): CustomerProfile {
    return new CustomerProfile(props);
  }

  /** A brand-new, still-empty profile row (§2 — created reactively on `identity.user.registered`). */
  static createEmpty(id: string, userId: string, now: Date = new Date()): CustomerProfile {
    return new CustomerProfile({
      id,
      userId,
      fullName: null,
      gender: null,
      dateOfBirth: null,
      secondaryPhone: null,
      timezone: null,
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
  get fullName(): string | null {
    return this.props.fullName;
  }
  get gender(): Gender | null {
    return this.props.gender;
  }
  get dateOfBirth(): Date | null {
    return this.props.dateOfBirth;
  }
  get secondaryPhone(): string | null {
    return this.props.secondaryPhone;
  }
  get timezone(): string | null {
    return this.props.timezone;
  }

  /**
   * Applies a PATCH edit set (module-02 §4.1). At least one field is required — an empty body
   * is a caller-level error, checked before this is invoked. `dateOfBirth` business validation
   * (past date, implied age <= 120) lives here because it depends on "now".
   */
  applyEdits(edits: CustomerProfileEdits, now: Date = new Date()): string[] {
    const changed: string[] = [];

    if (edits.fullName !== undefined) {
      this.props.fullName = edits.fullName;
      changed.push('fullName');
    }
    if (edits.gender !== undefined) {
      this.props.gender = edits.gender;
      changed.push('gender');
    }
    if (edits.dateOfBirth !== undefined) {
      this.assertValidDateOfBirth(edits.dateOfBirth, now);
      this.props.dateOfBirth = edits.dateOfBirth;
      changed.push('dateOfBirth');
    }
    if (edits.secondaryPhone !== undefined) {
      this.props.secondaryPhone = edits.secondaryPhone;
      changed.push('secondaryPhone');
    }
    if (edits.timezone !== undefined) {
      this.props.timezone = edits.timezone;
      changed.push('timezone');
    }

    if (changed.length > 0) {
      this.props.updatedAt = now;
    }
    return changed;
  }

  private assertValidDateOfBirth(dateOfBirth: Date, now: Date): void {
    if (Number.isNaN(dateOfBirth.getTime())) {
      throw ProfileErrors.validation('dateOfBirth must be a valid calendar date.', {
        field: 'dateOfBirth',
      });
    }
    if (dateOfBirth.getTime() >= now.getTime()) {
      throw ProfileErrors.validation('dateOfBirth must be in the past.', {
        field: 'dateOfBirth',
      });
    }
    const maxAgeMs = MAX_AGE_YEARS * 365.25 * 24 * 60 * 60 * 1000;
    if (now.getTime() - dateOfBirth.getTime() > maxAgeMs) {
      throw ProfileErrors.validation('dateOfBirth implies an age over 120 years.', {
        field: 'dateOfBirth',
      });
    }
  }

  toProps(): Readonly<CustomerProfileProps> {
    return { ...this.props };
  }
}
