import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ENCRYPTION_PORT, IEncryptionPort } from '../../../../shared/crypto/crypto.port';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ConsentType, VerificationType } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import {
  CONSENT_REPOSITORY,
  IConsentRepository,
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import {
  IDENTITY_VERIFICATION_PROVIDER,
  IIdentityVerificationProvider,
} from '../ports/identity-verification.provider';

/** Consent text version captured with a Fayda submission (NFR-PRIV-03). */
const FAYDA_CONSENT_VERSION = 'FAYDA_V1';

export interface SubmitFaydaVerificationInput {
  userId: string;
  faydaId: string;
  consentGranted: boolean;
  fullName?: string | null;
  dateOfBirth?: string | null;
  organizationId?: string | null;
  ip?: string | null;
}

export interface SubmitFaydaVerificationResult {
  requestId: string;
  status: string;
}

/**
 * POST /verification/fayda (module-01 §9.2 steps 1-5, §11.6). The provider match is an automated
 * gate on submission — passing it only creates a PENDING request; a human admin still decides
 * (§9.4). The Fayda number is encrypted before it touches the database and is never returned.
 */
@Injectable()
export class SubmitFaydaVerificationCommand {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(CONSENT_REPOSITORY) private readonly consents: IConsentRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(IDENTITY_VERIFICATION_PROVIDER)
    private readonly provider: IIdentityVerificationProvider,
    @Inject(ENCRYPTION_PORT) private readonly encryption: IEncryptionPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: SubmitFaydaVerificationInput): Promise<SubmitFaydaVerificationResult> {
    if (!input.consentGranted) {
      throw IdentityErrors.validation('Consent is required to verify your Fayda identity.');
    }

    const user = await this.users.findById(input.userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }

    const existing = await this.verifications.findPendingForUser(
      input.userId,
      VerificationType.FAYDA,
    );
    if (existing) {
      throw IdentityErrors.verificationPending();
    }

    await this.consents.record(
      input.userId,
      ConsentType.DATA_PROCESSING,
      true,
      FAYDA_CONSENT_VERSION,
    );

    const match = await this.provider.verifyFayda({
      faydaId: input.faydaId,
      fullName: input.fullName ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
    });

    if (!match.matched) {
      await this.audit.record({
        actorUserId: input.userId,
        action: 'identity.verification.fayda_match_failed',
        resourceType: 'user',
        resourceId: input.userId,
        context: { reason: match.failureReason ?? null },
        ip: input.ip ?? null,
      });
      throw IdentityErrors.validation(
        match.failureReason ?? 'Your Fayda details could not be verified.',
      );
    }

    const request = await this.verifications.create({
      userId: input.userId,
      organizationId: input.organizationId ?? null,
      type: VerificationType.FAYDA,
      faydaIdEncrypted: this.encryption.encryptToString(input.faydaId),
      documents: [],
    });

    await this.audit.record({
      actorUserId: input.userId,
      action: 'identity.verification.submitted',
      resourceType: 'verification_request',
      resourceId: request.id,
      context: { type: VerificationType.FAYDA, providerReference: match.providerReference ?? null },
      ip: input.ip ?? null,
    });

    return { requestId: request.id, status: request.status };
  }
}
