import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../shared/audit/audit.service';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  IDENTITY_ORGANIZATION_READ_PORT,
  type IIdentityOrganizationReadPort,
} from '../../identity/application/ports/inbound/identity-organization-read.port';
import { providerActivatedEvent, providerSuspendedEvent } from '../domain/events';
import { organizationTypeFor, ProviderErrors, type ProviderStatus, type ProviderType } from '../domain/provider-rules';
import type { IProviderOnboardingPort, ProviderSummary } from './ports/inbound/provider-onboarding.port';

const SUMMARY = {
  id: true,
  organizationId: true,
  type: true,
  displayName: true,
  transactingStatus: true,
  licenseStatus: true,
  licenseExpiresAt: true,
} as const;

type SummaryRow = Prisma.HealthcareProviderGetPayload<{ select: typeof SUMMARY }>;

function toSummary(row: SummaryRow): ProviderSummary {
  return {
    providerId: row.id,
    organizationId: row.organizationId,
    type: row.type as ProviderType,
    displayName: row.displayName,
    status: row.transactingStatus as ProviderStatus,
    licenseStatus: row.licenseStatus,
    licenseExpiresAt: row.licenseExpiresAt,
  };
}

/**
 * Work 160: registering and controlling healthcare providers (module-09 §6, §8.3).
 *
 * A provider is the directory profile of a Module 01 HOSPITAL, CLINIC or LAB organisation. It may
 * operate (appear in discovery, publish services) only while it is ACTIVE, and it becomes ACTIVE
 * only when its organisation is ACTIVE on an approved facility licence that has not expired —
 * Module 01 writes the licence number and expiry on the organisation only when it approves one.
 * Suspension is manual (here) or automatic when the licence expires (the sweeper). Every change
 * is audited and announced on the outbox in the same transaction.
 */
@Injectable()
export class ProviderOnboardingService implements IProviderOnboardingPort {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly organizations: IIdentityOrganizationReadPort,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async findByOrganization(organizationId: string): Promise<ProviderSummary | null> {
    const row = await this.prisma.healthcareProvider.findFirst({ where: { organizationId, deletedAt: null }, select: SUMMARY });
    return row ? toSummary(row) : null;
  }

  async register(input: { adminUserId: string; organizationId: string; type: ProviderType; displayName: string }): Promise<{ providerId: string }> {
    const organization = await this.organizations.getOrganizationPeople(input.organizationId);
    if (!organization) throw ProviderErrors.notEligible('ORGANIZATION_NOT_FOUND');
    if (organization.type !== organizationTypeFor(input.type)) throw ProviderErrors.notEligible('ORGANIZATION_TYPE_MISMATCH');
    if (organization.owner.userId !== input.adminUserId) throw ProviderErrors.notEligible('NOT_OWNER');

    const existing = await this.findByOrganization(input.organizationId);
    if (existing) return { providerId: existing.providerId };

    const displayName = input.displayName.trim();
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.healthcareProvider.create({
          data: {
            organizationId: input.organizationId,
            type: input.type,
            displayName,
            nameEn: displayName,
            transactingStatus: 'PENDING',
            licenseStatus: 'VALID',
            licenseExpiresAt: organization.licenseExpiresAt,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorUserId: input.adminUserId,
            action: 'PROVIDER_REGISTERED',
            resourceType: 'HealthcareProvider',
            resourceId: row.id,
            context: { organizationId: input.organizationId, type: input.type },
          },
          tx,
        );
        return row;
      });
      return { providerId: created.id };
    } catch (err) {
      // `organizationId` is unique: a concurrent registration of the same organisation won.
      const winner = await this.findByOrganization(input.organizationId);
      if (winner) return { providerId: winner.providerId };
      throw err;
    }
  }

  async activate(input: { actorUserId: string; providerId: string }): Promise<boolean> {
    const provider = await this.prisma.healthcareProvider.findFirst({ where: { id: input.providerId, deletedAt: null }, select: SUMMARY });
    if (!provider) throw ProviderErrors.notFound();

    const organization = await this.organizations.getOrganizationPeople(provider.organizationId);
    if (!organization) throw ProviderErrors.notEligible('ORGANIZATION_NOT_FOUND');
    if (organization.type !== organizationTypeFor(provider.type as ProviderType)) throw ProviderErrors.notEligible('ORGANIZATION_TYPE_MISMATCH');
    if (organization.status !== 'ACTIVE') throw ProviderErrors.notEligible('ORGANIZATION_NOT_ACTIVE');
    if (!organization.licenseNumber || !organization.licenseExpiresAt) throw ProviderErrors.notEligible('LICENSE_MISSING');
    const expiresAt = organization.licenseExpiresAt;
    if (expiresAt.getTime() <= Date.now()) throw ProviderErrors.notEligible('LICENSE_EXPIRED');

    if (provider.transactingStatus === 'ACTIVE' && provider.licenseExpiresAt?.getTime() === expiresAt.getTime()) return false;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.healthcareProvider.updateMany({
        where: { id: provider.id, deletedAt: null, transactingStatus: provider.transactingStatus },
        data: { transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: expiresAt },
      });
      // Changed by someone else since it was read: the other decision stands.
      if (updated.count !== 1) return false;
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PROVIDER_ACTIVATED',
          resourceType: 'HealthcareProvider',
          resourceId: provider.id,
          context: { previousStatus: provider.transactingStatus, licenseNumber: organization.licenseNumber, licenseExpiresAt: expiresAt.toISOString() },
        },
        tx,
      );
      await this.outbox.write(providerActivatedEvent({ providerId: provider.id, organizationId: provider.organizationId, type: provider.type }), tx as never);
      return true;
    });
  }

  async suspend(input: { actorUserId: string; providerId: string; reason: string }): Promise<boolean> {
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3 || reason.length > 500) throw ProviderErrors.reasonRequired();
    const provider = await this.prisma.healthcareProvider.findFirst({ where: { id: input.providerId, deletedAt: null }, select: SUMMARY });
    if (!provider) throw ProviderErrors.notFound();
    if (provider.transactingStatus === 'SUSPENDED') return false;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.healthcareProvider.updateMany({
        where: { id: provider.id, deletedAt: null, transactingStatus: { not: 'SUSPENDED' } },
        data: { transactingStatus: 'SUSPENDED' },
      });
      if (updated.count !== 1) return false;
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PROVIDER_SUSPENDED',
          resourceType: 'HealthcareProvider',
          resourceId: provider.id,
          context: { previousStatus: provider.transactingStatus, reason },
        },
        tx,
      );
      await this.outbox.write(providerSuspendedEvent({ providerId: provider.id, reason: 'MANUAL' }), tx as never);
      return true;
    });
  }

  async reactivate(input: { actorUserId: string; providerId: string }): Promise<boolean> {
    const provider = await this.prisma.healthcareProvider.findFirst({ where: { id: input.providerId, deletedAt: null }, select: SUMMARY });
    if (!provider) throw ProviderErrors.notFound();
    if (provider.transactingStatus === 'ACTIVE') return false;
    return this.activate(input);
  }
}
