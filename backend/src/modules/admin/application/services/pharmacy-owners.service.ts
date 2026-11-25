import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import {
  IDENTITY_ORGANIZATION_READ_PORT,
  type IIdentityOrganizationReadPort,
  type OwnerView,
} from '../../../identity/application/ports/inbound/identity-organization-read.port';
import {
  PHARMACY_ONBOARDING_PORT,
  type IPharmacyOnboardingPort,
} from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-onboarding.port';
import { ReinstateUserCommand } from '../commands/reinstate-user.command';
import { SuspendUserCommand } from '../commands/suspend-user.command';

export interface OwnedPharmacy {
  organizationId: string;
  /** The organisation's legal name. */
  name: string;
  organizationStatus: string;
  /** Null when the organisation has no storefront yet. */
  pharmacyId: string | null;
  transactingStatus: string | null;
}

export interface OwnerRecord extends Omit<OwnerView, 'organizations'> {
  pharmacies: OwnedPharmacy[];
}

/** What changed for each pharmacy when its owner was disabled or enabled. */
export interface OwnerPharmacyOutcome {
  pharmacyId: string;
  outcome: 'disabled' | 'already disabled' | 'enabled' | 'not enabled';
  /** Why a pharmacy could not be enabled again (e.g. its licence expired). */
  reason?: string;
}

/**
 * Work 157: pharmacy owners — the people who own one or more pharmacies — for the Super Admin.
 * List and record are read through Module 01's organisation read (and Module 04 for each
 * storefront). Disabling an owner suspends their account (they are signed out and cannot sign in)
 * and, when asked, disables every pharmacy they own; enabling reinstates the account and, when
 * asked, enables each pharmacy again — which re-checks its licence, so one that cannot trade stays
 * disabled and says why. Each step is the existing audited command.
 */
@Injectable()
export class PharmacyOwnersService {
  constructor(
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly organizations: IIdentityOrganizationReadPort,
    @Inject(PHARMACY_ONBOARDING_PORT) private readonly pharmacies: IPharmacyOnboardingPort,
    private readonly suspendUser: SuspendUserCommand,
    private readonly reinstateUser: ReinstateUserCommand,
  ) {}

  async list(input: { identifier?: string; status?: string; page?: number; size?: number }) {
    const page = input.page && input.page > 0 ? Math.floor(input.page) : 1;
    const size = input.size && input.size > 0 ? Math.min(Math.floor(input.size), 100) : 25;
    const { items, total } = await this.organizations.listOwners({ identifier: input.identifier, status: input.status }, page, size);
    return { items: items.map((o) => ({ ...o, pharmacyCount: o.organizations.length })), total, page, size };
  }

  async record(userId: string): Promise<OwnerRecord> {
    const owner = await this.organizations.getOwner(userId);
    if (!owner) throw ApiException.notFound('This account owns no pharmacy.');
    const { organizations, ...person } = owner;
    const pharmacies = await Promise.all(
      organizations.map(async (o): Promise<OwnedPharmacy> => {
        const storefront = await this.pharmacies.findByOrganization(o.organizationId);
        return {
          organizationId: o.organizationId,
          name: o.name,
          organizationStatus: o.status,
          pharmacyId: storefront?.pharmacyId ?? null,
          transactingStatus: storefront?.transactingStatus ?? null,
        };
      }),
    );
    return { ...person, pharmacies };
  }

  async disable(input: { actorUserId: string; userId: string; reason: string; alsoPharmacies: boolean; ip: string | null }) {
    const owner = await this.record(input.userId);
    const account = await this.suspendUser.execute({ actorUserId: input.actorUserId, targetUserId: input.userId, reason: input.reason, ip: input.ip });
    const outcomes: OwnerPharmacyOutcome[] = [];
    if (input.alsoPharmacies) {
      for (const p of owner.pharmacies) {
        if (!p.pharmacyId) continue;
        const changed = await this.pharmacies.suspend({ actorUserId: input.actorUserId, pharmacyId: p.pharmacyId, reason: `Owner disabled: ${input.reason}` });
        outcomes.push({ pharmacyId: p.pharmacyId, outcome: changed ? 'disabled' : 'already disabled' });
      }
    }
    return { account, pharmacies: outcomes };
  }

  async enable(input: { actorUserId: string; userId: string; reason: string | null; alsoPharmacies: boolean; ip: string | null }) {
    const owner = await this.record(input.userId);
    const account = await this.reinstateUser.execute({ actorUserId: input.actorUserId, targetUserId: input.userId, reason: input.reason, ip: input.ip });
    const outcomes: OwnerPharmacyOutcome[] = [];
    if (input.alsoPharmacies) {
      for (const p of owner.pharmacies) {
        if (!p.pharmacyId || p.transactingStatus === 'ACTIVE') continue;
        try {
          await this.pharmacies.activate({ actorUserId: input.actorUserId, pharmacyId: p.pharmacyId });
          outcomes.push({ pharmacyId: p.pharmacyId, outcome: 'enabled' });
        } catch (error) {
          outcomes.push({ pharmacyId: p.pharmacyId, outcome: 'not enabled', reason: error instanceof Error ? error.message : 'Refused.' });
        }
      }
    }
    return { account, pharmacies: outcomes };
  }
}
