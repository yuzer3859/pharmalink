import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DriverIdentityView,
  DriverIneligibilityReason,
  IIdentityPort,
} from '../../application/ports/outbound/identity.port';

/**
 * Module 08's own `IIdentityPort` adapter — direct, in-process `PrismaService` reads of Module
 * 01's `users` and `verification_requests`, never a Prisma relation (ADR-002). Own copy,
 * mirroring Module 04/06/07's equivalents rather than importing any of them.
 *
 * Read-only, and it will stay that way: Module 08 has no business writing a verification record.
 *
 * ## What "verified driver" resolves to
 *
 * Module 01 has no `driver_profiles` table and no driver aggregate. A driver there *is*:
 *
 *  1. a `users` row whose `primaryRole` is `DRIVER`,
 *  2. which is `ACTIVE` and not soft-deleted, and
 *  3. for which a `VerificationRequest` of type `DRIVER_DOCS` has been `APPROVED` and has not
 *     passed its `expiresAt` (BRULE-08's licence expiry; `null` means no expiry).
 *
 * All three are required. Dropping (2) would let a suspended account keep working, which is
 * exactly the halt the domain-event catalogue assigns to Module 08 on `AccountSuspended`.
 * Dropping (3) would make BRULE-09 decorative.
 *
 * The `select` clauses are narrow on purpose: this adapter reads an *identity* table, and the
 * only fields it pulls are the ones the decision needs. `faydaIdEncrypted`, `documents` and
 * `rejectReason` are never selected — a field never read cannot be leaked by a later change, and
 * delivery has no business holding a driver's identity documents.
 */
@Injectable()
export class IdentityPortAdapter implements IIdentityPort {
  constructor(private readonly prisma: PrismaService) {}

  async getDriverIdentity(userId: string): Promise<DriverIdentityView> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, primaryRole: true, status: true },
    });

    if (!user) {
      return ineligible(userId, 'USER_NOT_FOUND');
    }
    if (user.primaryRole !== 'DRIVER') {
      return ineligible(userId, 'NOT_A_DRIVER');
    }
    if (user.status !== 'ACTIVE') {
      return ineligible(userId, 'ACCOUNT_NOT_ACTIVE');
    }

    // The most recently reviewed approval wins. A driver can accumulate several `DRIVER_DOCS`
    // requests over time — a renewal after an expiry, a resubmission after a rejection — and the
    // question is whether the *current* one is good, not whether any historical one was.
    const approval = await this.prisma.verificationRequest.findFirst({
      where: { userId, type: 'DRIVER_DOCS', status: 'APPROVED' },
      orderBy: [{ reviewedAt: 'desc' }, { submittedAt: 'desc' }],
      select: { expiresAt: true },
    });

    if (!approval) {
      return ineligible(userId, 'DOCUMENTS_NOT_APPROVED');
    }
    // `expiresAt === null` is "no expiry recorded", not "expired". Only a licence that carries a
    // date can lapse, and §9.3 sets one only where the approved document has one.
    if (approval.expiresAt !== null && approval.expiresAt.getTime() <= Date.now()) {
      return { ...ineligible(userId, 'DOCUMENTS_EXPIRED'), documentsExpireAt: approval.expiresAt };
    }

    return {
      userId,
      isEligible: true,
      reason: null,
      documentsExpireAt: approval.expiresAt,
    };
  }
}

function ineligible(userId: string, reason: DriverIneligibilityReason): DriverIdentityView {
  return { userId, isEligible: false, reason, documentsExpireAt: null };
}
