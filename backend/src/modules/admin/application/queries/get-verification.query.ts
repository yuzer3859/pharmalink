import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  VerificationDetailView,
} from '../../../identity/application/ports/inbound/identity-admin.port';
import { computeAging, VerificationAging } from '../support/verification-aging';

export interface VerificationReviewView extends VerificationDetailView {
  aging: VerificationAging;
}

/**
 * `GET /admin/verifications/:id` (module-16 §9.1, F-AD-02) — one request, with what a reviewer
 * needs to decide it.
 *
 * The shape is Module 01's `VerificationDetailView` plus aging. What is in it is a decision Module
 * 01 made when it built the projection: opaque `storageRef` values (never bytes, never a URL —
 * Module 01 has no signed-URL contract and this work invents none), `hasFaydaId` rather than the
 * identifier, and the applicant's role and account status rather than their profile. This module
 * does not widen it, and it does not copy any of it anywhere.
 *
 * Reads are not audited. The repository has no sensitive-read audit convention — no module
 * records a `*_VIEWED` action — and the design's "audited access" for document reads is deferred
 * with the document-access work itself, which does not exist yet; what this view returns is
 * references, not documents.
 */
@Injectable()
export class GetVerificationQuery {
  constructor(@Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort) {}

  async execute(requestId: string, now: Date = new Date()): Promise<VerificationReviewView> {
    const detail = await this.identity.getVerificationRequest(requestId);
    if (!detail) {
      throw ApiException.notFound('Verification request not found');
    }
    return { ...detail, aging: computeAging(detail, now) };
  }
}
