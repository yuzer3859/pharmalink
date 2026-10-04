import { ErrorCode } from '../../../../shared/errors/error-codes';
import { VerificationStatus, VerificationType } from '../enums';
import { VerificationRequest, VerificationRequestProps } from './verification-request.entity';

function makeRequest(overrides: Partial<VerificationRequestProps> = {}): VerificationRequest {
  return VerificationRequest.rehydrate({
    id: 'req-1',
    userId: 'user-1',
    organizationId: null,
    type: VerificationType.PHARMACY_LICENSE,
    status: VerificationStatus.PENDING,
    faydaIdEncrypted: null,
    documents: [],
    reviewerId: null,
    rejectReason: null,
    submittedAt: new Date('2026-01-01T00:00:00.000Z'),
    reviewedAt: null,
    expiresAt: null,
    ...overrides,
  });
}

describe('VerificationRequest entity', () => {
  it('approves a pending request and records the reviewer and expiry', () => {
    const request = makeRequest();
    const expiry = new Date('2027-01-01T00:00:00.000Z');

    request.approve('admin-1', expiry);

    expect(request.status).toBe(VerificationStatus.APPROVED);
    expect(request.reviewerId).toBe('admin-1');
    expect(request.expiresAt).toEqual(expiry);
    expect(request.reviewedAt).not.toBeNull();
  });

  it('forbids the subject from reviewing their own request', () => {
    const request = makeRequest();

    expect(() => request.approve('user-1', null)).toThrow(
      expect.objectContaining({ code: ErrorCode.FORBIDDEN }),
    );
    expect(request.status).toBe(VerificationStatus.PENDING);
  });

  it('refuses to re-decide a closed request', () => {
    const approved = makeRequest({ status: VerificationStatus.APPROVED });

    expect(() => approved.reject('admin-1', 'changed my mind')).toThrow(
      expect.objectContaining({ code: ErrorCode.BUSINESS_RULE_VIOLATION }),
    );
  });

  it('requires a non-empty rejection reason', () => {
    const request = makeRequest();

    expect(() => request.reject('admin-1', '   ')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
    );
    expect(request.status).toBe(VerificationStatus.PENDING);
  });

  it('records the rejection reason', () => {
    const request = makeRequest();
    request.reject('admin-1', 'Licence illegible');

    expect(request.status).toBe(VerificationStatus.REJECTED);
    expect(request.rejectReason).toBe('Licence illegible');
  });

  it('expires only an approved licence', () => {
    const approved = makeRequest({ status: VerificationStatus.APPROVED });
    approved.markExpired();
    expect(approved.status).toBe(VerificationStatus.EXPIRED);

    expect(() => makeRequest().markExpired()).toThrow();
  });

  it('attaches documents only while pending', () => {
    const request = makeRequest();
    request.attachDocuments([{ kind: 'BUSINESS_LICENSE', storageRef: 's3://a' }]);
    expect(request.documents).toHaveLength(1);

    const approved = makeRequest({ status: VerificationStatus.APPROVED });
    expect(() => approved.attachDocuments([{ kind: 'X', storageRef: 's3://b' }])).toThrow();
  });

  it('does not leak internal document state through the getter', () => {
    const request = makeRequest();
    request.documents.push({ kind: 'FORGED', storageRef: 's3://evil' });
    expect(request.documents).toHaveLength(0);
  });
});
