import { Inject, Injectable } from '@nestjs/common';
import { ENCRYPTION_PORT, IEncryptionPort } from '../../../../shared/crypto/crypto.port';
import { VerificationType } from '../../domain/enums';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';

export interface VerificationStatusView {
  requestId: string;
  type: string;
  status: string;
  /** Masked Fayda number, e.g. `****1234` — the plaintext is never returned (module-01 §9.4). */
  faydaIdMasked: string | null;
  documentCount: number;
  rejectReason: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  expiresAt: Date | null;
}

/** Shows only the final digits; anything shorter than 4 digits is fully masked. */
export function maskFaydaId(faydaId: string): string {
  const last4 = faydaId.slice(-4);
  return last4.length === 4 ? `****${last4}` : '****';
}

/**
 * GET /verification/status (module-01 §11.6). Returns every request the caller has made, newest
 * first, so a provider can see a rejection reason alongside a newer pending attempt.
 */
@Injectable()
export class GetVerificationStatusQuery {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(ENCRYPTION_PORT) private readonly encryption: IEncryptionPort,
  ) {}

  async execute(userId: string): Promise<VerificationStatusView[]> {
    const requests = await this.verifications.listForUser(userId);

    return requests.map((request) => {
      const props = request.toProps();
      return {
        requestId: request.id,
        type: request.type,
        status: request.status,
        faydaIdMasked:
          request.type === VerificationType.FAYDA && props.faydaIdEncrypted
            ? maskFaydaId(this.encryption.decryptFromString(props.faydaIdEncrypted).toString('utf8'))
            : null,
        documentCount: request.documents.length,
        rejectReason: request.rejectReason,
        submittedAt: request.submittedAt,
        reviewedAt: request.reviewedAt,
        expiresAt: request.expiresAt,
      };
    });
  }
}
