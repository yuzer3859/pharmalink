import { IEncryptionPort } from '../../../../shared/crypto/crypto.port';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { IVerificationRepository } from '../../domain/repositories/verification.repository';
import { GetVerificationStatusQuery, maskFaydaId } from './get-verification-status.query';

function request(type: VerificationType, faydaIdEncrypted: string | null): VerificationRequest {
  return VerificationRequest.rehydrate({
    id: 'req-1',
    userId: 'user-1',
    organizationId: null,
    type,
    status: VerificationStatus.PENDING,
    faydaIdEncrypted,
    documents: [{ kind: 'BUSINESS_LICENSE', storageRef: 's3://a' }],
    reviewerId: null,
    rejectReason: null,
    submittedAt: new Date(),
    reviewedAt: null,
    expiresAt: null,
  });
}

describe('maskFaydaId', () => {
  it('shows only the last four digits', () => {
    expect(maskFaydaId('123456789012')).toBe('****9012');
  });

  it('fully masks anything shorter than four characters', () => {
    expect(maskFaydaId('12')).toBe('****');
  });
});

describe('GetVerificationStatusQuery', () => {
  const encryption = {
    decryptFromString: jest.fn().mockReturnValue(Buffer.from('123456789012', 'utf8')),
  } as unknown as IEncryptionPort;

  it('returns the Fayda number masked, never in plaintext', async () => {
    const verifications = {
      listForUser: jest.fn().mockResolvedValue([request(VerificationType.FAYDA, 'enc')]),
    } as unknown as IVerificationRepository;

    const result = await new GetVerificationStatusQuery(verifications, encryption).execute('user-1');

    expect(result[0].faydaIdMasked).toBe('****9012');
    expect(JSON.stringify(result)).not.toContain('123456789012');
  });

  it('omits the mask for non-Fayda requests', async () => {
    const verifications = {
      listForUser: jest.fn().mockResolvedValue([request(VerificationType.DRIVER_DOCS, null)]),
    } as unknown as IVerificationRepository;

    const result = await new GetVerificationStatusQuery(verifications, encryption).execute('user-1');

    expect(result[0].faydaIdMasked).toBeNull();
    expect(result[0].documentCount).toBe(1);
  });
});
