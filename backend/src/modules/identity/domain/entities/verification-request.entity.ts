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

  approve(reviewerId: string, expiresAt: Date | null, now: Date = new Date()): void {
    this.assertReviewable(reviewerId);
    this.props.status = VerificationStatus.APPROVED;
    this.props.reviewerId = reviewerId;
    this.props.reviewedAt = now;
    this.props.expiresAt = expiresAt;
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
