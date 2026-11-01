import { VerificationStatus, VerificationType } from '../enums';
import { IdentityErrors } from '../errors';

export interface VerificationDocument {
  /** Role-specific document kind, e.g. BUSINESS_LICENSE, DRIVING_LICENSE (module-01 §9.2). */
  kind: string;
  /** Opaque reference into encrypted object storage — never the document bytes themselves. */
  storageRef: string;
  expiresAt?: string | null;
}

export interface VerificationRequestProps {
  id: string;
  userId: string;
  organizationId: string | null;
  type: VerificationType;
  status: VerificationStatus;
  faydaIdEncrypted: string | null;
  documents: VerificationDocument[];
  reviewerId: string | null;
  rejectReason: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  expiresAt: Date | null;
  /** Approved licence number (Work 67). Only a PHARMACY_LICENSE approval sets it. */
  licenseNumber: string | null;
}

/** Upper bound on a stored licence number; the database CHECK constraint matches it. */
export const LICENSE_NUMBER_MAX_LENGTH = 64;

/**
 * Trims a licence number and checks it is a non-empty, bounded string. No national format is
 * enforced: none is specified, so the administrator's transcription is stored as given.
 */
export function normalizeLicenseNumber(raw: string | null | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0 || value.length > LICENSE_NUMBER_MAX_LENGTH) {
    throw IdentityErrors.validation(
      `A licence number of 1 to ${LICENSE_NUMBER_MAX_LENGTH} characters is required.`,
      { field: 'licenseNumber' },
    );
  }
  return value;
}

/**
 * VerificationRequest aggregate (module-01 §9). Owns the review lifecycle and the separation-of-
 * duties rule: a human admin other than the subject must decide, and a decision is final —
 * re-deciding a closed request is rejected rather than silently overwritten, because the audit
 * trail for regulated approvals must be unambiguous (§9.4, BRULE-39).
 */
export class VerificationRequest {
  private constructor(private props: VerificationRequestProps) {}

  static rehydrate(props: VerificationRequestProps): VerificationRequest {
    return new VerificationRequest(props);
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get organizationId(): string | null {
    return this.props.organizationId;
  }
  get type(): VerificationType {
    return this.props.type;
  }
  get status(): VerificationStatus {
    return this.props.status;
  }
  get documents(): VerificationDocument[] {
    return [...this.props.documents];
  }
  get expiresAt(): Date | null {
    return this.props.expiresAt;
  }
  get licenseNumber(): string | null {
    return this.props.licenseNumber;
  }
  get reviewerId(): string | null {
    return this.props.reviewerId;
  }
  get rejectReason(): string | null {
    return this.props.rejectReason;
  }
  get submittedAt(): Date {
    return this.props.submittedAt;
  }
  get reviewedAt(): Date | null {
    return this.props.reviewedAt;
  }

  /** Attaches uploaded document references while the request is still open. */
  attachDocuments(documents: VerificationDocument[]): void {
    if (this.props.status !== VerificationStatus.PENDING) {
      throw IdentityErrors.verificationClosed(this.props.status);
    }
    this.props.documents = [...this.props.documents, ...documents];
  }

  /**
   * Approves any request except a pharmacy licence, which needs `approvePharmacyLicense`: a
   * pharmacy licence approval without a licence number and a future expiry would leave an
   * organisation active on a licence nobody recorded.
   */
  approve(reviewerId: string, expiresAt: Date | null, now: Date = new Date()): void {
    this.assertReviewable(reviewerId);
    if (this.props.type === VerificationType.PHARMACY_LICENSE) {
      throw IdentityErrors.validation(
        'A pharmacy licence approval requires the licence number and its expiry.',
        { fields: ['licenseNumber', 'expiresAt'] },
      );
    }
    this.props.status = VerificationStatus.APPROVED;
    this.props.reviewerId = reviewerId;
    this.props.reviewedAt = now;
    this.props.expiresAt = expiresAt;
    this.props.rejectReason = null;
  }

  /**
   * Pharmacy licence approval (Work 67): records the approved licence number (trimmed, 1 to 64
   * characters) and an expiry strictly later than the approval time.
   */
  approvePharmacyLicense(
    reviewerId: string,
    licence: { licenseNumber: string; expiresAt: Date },
    now: Date = new Date(),
  ): void {
    if (this.props.type !== VerificationType.PHARMACY_LICENSE) {
      throw IdentityErrors.validation('Only a pharmacy licence request records a licence number.');
    }
    this.assertReviewable(reviewerId);
    const licenseNumber = normalizeLicenseNumber(licence.licenseNumber);
    const expiresAt = licence.expiresAt;
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
      throw IdentityErrors.validation('The licence expiry must be a date later than now.', {
        field: 'expiresAt',
      });
    }
    this.props.status = VerificationStatus.APPROVED;
    this.props.reviewerId = reviewerId;
    this.props.reviewedAt = now;
    this.props.expiresAt = expiresAt;
    this.props.licenseNumber = licenseNumber;
    this.props.rejectReason = null;
  }

  reject(reviewerId: string, reason: string, now: Date = new Date()): void {
    this.assertReviewable(reviewerId);
    if (!reason.trim()) {
      throw IdentityErrors.validation('A rejection reason is required.');
    }
    this.props.status = VerificationStatus.REJECTED;
    this.props.reviewerId = reviewerId;
    this.props.reviewedAt = now;
    this.props.rejectReason = reason;
  }

  /** Scheduled licence-expiry transition (module-01 §9.3, BRULE-08). */
  markExpired(now: Date = new Date()): void {
    if (this.props.status !== VerificationStatus.APPROVED) {
      throw IdentityErrors.verificationClosed(this.props.status);
    }
    this.props.status = VerificationStatus.EXPIRED;
    this.props.reviewedAt = this.props.reviewedAt ?? now;
  }

  private assertReviewable(reviewerId: string): void {
    if (this.props.status !== VerificationStatus.PENDING) {
      throw IdentityErrors.verificationClosed(this.props.status);
    }
    if (reviewerId === this.props.userId) {
      throw IdentityErrors.selfReview();
    }
  }

  toProps(): Readonly<VerificationRequestProps> {
    return { ...this.props, documents: [...this.props.documents] };
  }
}
