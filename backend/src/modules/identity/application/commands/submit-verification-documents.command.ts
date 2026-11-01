import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { VerificationDocument, VerificationRequest } from '../../domain/entities/verification-request.entity';
import { VerificationType } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import {
  IOrganizationRepository,
  ORGANIZATION_REPOSITORY,
} from '../../domain/repositories/organization.repository';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';

export interface SubmitVerificationDocumentsInput {
  userId: string;
  type: VerificationType;
  organizationId?: string | null;
  documents: VerificationDocument[];
  ip?: string | null;
}

export interface SubmitVerificationDocumentsResult {
  requestId: string;
  status: string;
  documentCount: number;
}

/**
 * POST /verification/documents (module-01 §9.2 step 3, §11.6). Accepts references to objects
 * already uploaded to encrypted storage — the bytes never pass through this service. Documents
 * attach to the caller's open request of that type, or open one if none exists, so a provider can
 * upload paperwork across several calls without creating duplicate queue entries.
 *
 * PHARMACY_LICENSE is organisation-scoped (Work 67): `organizationId` is required and must be the
 * caller's own undeleted PHARMACY organisation, and documents attach to the open request for that
 * exact (owner, organisation). Finding or opening that request, attaching and auditing run in one
 * Serializable transaction, and a partial unique index allows one open request per pair, so
 * concurrent submissions converge on a single request. Other types keep their per-(user, type)
 * behaviour.
 */
@Injectable()
export class SubmitVerificationDocumentsCommand {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: IOrganizationRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: SubmitVerificationDocumentsInput,
  ): Promise<SubmitVerificationDocumentsResult> {
    if (input.type === VerificationType.PHARMACY_LICENSE) {
      return this.submitPharmacyLicense(input);
    }

    const existing = await this.verifications.findPendingForUser(input.userId, input.type);

    const request =
      existing ??
      (await this.verifications.create({
        userId: input.userId,
        organizationId: input.organizationId ?? null,
        type: input.type,
        faydaIdEncrypted: null,
        documents: [],
      }));

    request.attachDocuments(input.documents);
    await this.verifications.save(request);

    await this.audit.record({
      actorUserId: input.userId,
      action: 'identity.verification.documents_attached',
      resourceType: 'verification_request',
      resourceId: request.id,
      context: { type: input.type, kinds: input.documents.map((d) => d.kind) },
      ip: input.ip ?? null,
    });

    return toResult(request);
  }

  private async submitPharmacyLicense(
    input: SubmitVerificationDocumentsInput,
  ): Promise<SubmitVerificationDocumentsResult> {
    const organizationId = input.organizationId;
    if (!organizationId) {
      throw IdentityErrors.licenseOrganizationRequired();
    }
    const organization = await this.organizations.findById(organizationId);
    if (!organization || organization.deletedAt || organization.ownerUserId !== input.userId) {
      throw IdentityErrors.organizationNotFound();
    }
    if (organization.type !== 'PHARMACY') {
      throw IdentityErrors.notPharmacyOrganization();
    }

    const attempt = () =>
      this.uow.run(
        async (tx) => {
          const request =
            (await this.verifications.findPendingPharmacyLicense(input.userId, organizationId, tx)) ??
            (await this.verifications.create(
              {
                userId: input.userId,
                organizationId,
                type: VerificationType.PHARMACY_LICENSE,
                faydaIdEncrypted: null,
                documents: [],
              },
              tx,
            ));
          request.attachDocuments(input.documents);
          await this.verifications.save(request, undefined, tx);
          await this.audit.record(
            {
              actorUserId: input.userId,
              action: 'identity.verification.documents_attached',
              resourceType: 'verification_request',
              resourceId: request.id,
              context: {
                type: input.type,
                organizationId,
                kinds: input.documents.map((d) => d.kind),
              },
              ip: input.ip ?? null,
            },
            tx,
          );
          return request;
        },
        { isolation: 'serializable' },
      );

    // Concurrent uploads for one application all write the same row and the audit chain, so
    // several can lose a round of the unit of work's bounded retry, or hit the partial unique
    // index when another opened the request first. Run a few more rounds with jittered backoff;
    // each round re-reads and appends to the request that won. Anything else propagates.
    for (let round = 1; ; round += 1) {
      try {
        return toResult(await attempt());
      } catch (err) {
        if (round >= SUBMISSION_ROUNDS || !isRetryableConflict(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, SUBMISSION_BACKOFF_MS * round * (0.5 + Math.random())));
      }
    }
  }
}

const SUBMISSION_ROUNDS = 5;
const SUBMISSION_BACKOFF_MS = 20;

function isRetryableConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'P2002' || code === 'P2034' || code === '40001' || code === '40P01';
}

function toResult(request: VerificationRequest): SubmitVerificationDocumentsResult {
  return {
    requestId: request.id,
    status: request.status,
    documentCount: request.documents.length,
  };
}
