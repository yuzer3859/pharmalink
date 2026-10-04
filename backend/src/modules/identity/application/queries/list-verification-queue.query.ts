import { Inject, Injectable } from '@nestjs/common';
import { VerificationStatus } from '../../domain/enums';
import { PaginatedResult } from '../../domain/repositories/auth.repositories';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';

export interface VerificationQueueItem {
  requestId: string;
  userId: string;
  organizationId: string | null;
  type: string;
  documentCount: number;
  submittedAt: Date;
}

const DEFAULT_PAGE = 1;
const DEFAULT_SIZE = 20;
const MAX_SIZE = 100;

/**
 * GET /admin/verification/queue (module-01 §11.7, permission `verification:queue:read`). The
 * queue deliberately omits the Fayda number entirely — reviewers work from the documents, and
 * §9.4 forbids returning the identifier.
 */
@Injectable()
export class ListVerificationQueueQuery {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
  ) {}

  async execute(page = DEFAULT_PAGE, size = DEFAULT_SIZE): Promise<PaginatedResult<VerificationQueueItem>> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : DEFAULT_PAGE;
    const safeSize = Number.isFinite(size) && size > 0 ? Math.min(Math.floor(size), MAX_SIZE) : DEFAULT_SIZE;

    const result = await this.verifications.listByStatus(
      VerificationStatus.PENDING,
      safePage,
      safeSize,
    );

    return {
      ...result,
      items: result.items.map((request) => ({
        requestId: request.id,
        userId: request.userId,
        organizationId: request.organizationId,
        type: request.type,
        documentCount: request.documents.length,
        submittedAt: request.submittedAt,
      })),
    };
  }
}
