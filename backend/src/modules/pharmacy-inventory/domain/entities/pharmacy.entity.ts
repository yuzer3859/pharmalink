import { LicenseStatus, TransactingStatus } from '../enums';
import { TransactingEligibilityPolicy } from '../services/transacting-eligibility.policy';

export interface PharmacyProps {
  id: string;
  organizationId: string;
  displayName: string;
  logoUrl: string | null;
  description: string | null;
  ratingAvg: number;
  ratingCount: number;
  transactingStatus: TransactingStatus;
  licenseStatus: LicenseStatus;
  licenseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Pharmacy aggregate root (module-04 §3.1). Framework-free. */
export class Pharmacy {
  private constructor(private props: PharmacyProps) {}

  static rehydrate(props: PharmacyProps): Pharmacy {
    return new Pharmacy(props);
  }

  static register(
    id: string,
    input: { organizationId: string; displayName: string; logoUrl?: string | null; description?: string | null },
    now: Date = new Date(),
  ): Pharmacy {
    return new Pharmacy({
      id,
      organizationId: input.organizationId,
      displayName: input.displayName,
      logoUrl: input.logoUrl ?? null,
      description: input.description ?? null,
      ratingAvg: 0,
      ratingCount: 0,
      transactingStatus: TransactingStatus.PENDING,
      licenseStatus: LicenseStatus.VALID,
      licenseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  get id(): string {
    return this.props.id;
  }
  get organizationId(): string {
    return this.props.organizationId;
  }

  isEligible(now: Date = new Date()): boolean {
    return TransactingEligibilityPolicy.isEligible(this.props, now);
  }

  activate(licenseExpiresAt: Date | null, now: Date = new Date()): void {
    this.props.transactingStatus = TransactingStatus.ACTIVE;
    this.props.licenseStatus = LicenseStatus.VALID;
    this.props.licenseExpiresAt = licenseExpiresAt;
    this.props.updatedAt = now;
  }

  suspendForExpiredLicense(now: Date = new Date()): void {
    this.props.transactingStatus = TransactingStatus.SUSPENDED;
    this.props.licenseStatus = LicenseStatus.EXPIRED;
    this.props.updatedAt = now;
  }

  applyProfileEdits(
    edits: { displayName?: string; logoUrl?: string | null; description?: string | null },
    now: Date = new Date(),
  ): void {
    if (edits.displayName !== undefined) this.props.displayName = edits.displayName;
    if (edits.logoUrl !== undefined) this.props.logoUrl = edits.logoUrl;
    if (edits.description !== undefined) this.props.description = edits.description;
    this.props.updatedAt = now;
  }

  toProps(): Readonly<PharmacyProps> {
    return { ...this.props };
  }
}
