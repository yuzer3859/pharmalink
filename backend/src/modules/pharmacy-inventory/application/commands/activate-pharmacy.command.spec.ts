import { AuditService } from '../../../../shared/audit/audit.service';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Pharmacy, PharmacyProps } from '../../domain/entities/pharmacy.entity';
import { LicenseStatus, TransactingStatus } from '../../domain/enums';
import { PharmacyInventoryEventType } from '../../domain/events';
import { IPharmacyRepository } from '../../domain/repositories/pharmacy.repository';
import { ApprovedPharmacyLicenseView, IIdentityPort, OrganizationView } from '../ports/outbound/identity.port';
import { IUnitOfWork } from '../ports/outbound/unit-of-work.port';
import { ActivatePharmacyCommand } from './activate-pharmacy.command';

const EXPIRES = new Date(Date.now() + 365 * 24 * 3600 * 1000);

function pharmacy(overrides: Partial<PharmacyProps> = {}): Pharmacy {
  return Pharmacy.rehydrate({
    id: 'ph-1',
    organizationId: 'org-1',
    displayName: 'Abebe Pharmacy',
    logoUrl: null,
    description: null,
    ratingAvg: 0,
    ratingCount: 0,
    transactingStatus: TransactingStatus.PENDING,
    licenseStatus: LicenseStatus.VALID,
    licenseExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  });
}

function organization(overrides: Partial<OrganizationView> = {}): OrganizationView {
  return {
    id: 'org-1',
    type: 'PHARMACY',
    status: 'ACTIVE',
    ownerUserId: 'owner-1',
    licenseNumber: 'LIC-1',
    licenseExpiresAt: EXPIRES,
    ...overrides,
  };
}

function licence(overrides: Partial<ApprovedPharmacyLicenseView> = {}): ApprovedPharmacyLicenseView {
  return {
    verificationRequestId: 'req-1',
    organizationId: 'org-1',
    userId: 'owner-1',
    licenseNumber: 'LIC-1',
    expiresAt: EXPIRES,
    approvedAt: new Date(),
    ...overrides,
  };
}

describe('ActivatePharmacyCommand (Work 67)', () => {
  let pharmacies: jest.Mocked<IPharmacyRepository>;
  let identity: jest.Mocked<IIdentityPort>;
  let uow: jest.Mocked<IUnitOfWork>;
  let audit: jest.Mocked<AuditService>;
  let outbox: jest.Mocked<OutboxService>;
  let command: ActivatePharmacyCommand;

  beforeEach(() => {
    pharmacies = {
      findByIdForUpdate: jest.fn().mockResolvedValue(pharmacy()),
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<IPharmacyRepository>;
    identity = {
      getOrganization: jest.fn().mockResolvedValue(organization()),
      getCurrentPharmacyLicense: jest.fn().mockResolvedValue(licence()),
    } as unknown as jest.Mocked<IIdentityPort>;
    uow = { run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')) } as unknown as jest.Mocked<IUnitOfWork>;
    audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
    outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<OutboxService>;
    command = new ActivatePharmacyCommand(pharmacies, identity, uow, audit, outbox);
  });

  const activate = () => command.execute({ actorUserId: 'admin-1', pharmacyId: 'ph-1' });

  function expectUntouched(): void {
    expect(pharmacies.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  }

  it('activates on a matching approved licence, copying its expiry, with one audit entry and one event', async () => {
    await expect(activate()).resolves.toEqual({ activated: true });

    expect(pharmacies.findByIdForUpdate).toHaveBeenCalledWith('ph-1', 'tx');
    expect(identity.getOrganization).toHaveBeenCalledWith('org-1', 'tx');
    expect(identity.getCurrentPharmacyLicense).toHaveBeenCalledWith('org-1', 'tx');
    const saved = (pharmacies.update.mock.calls[0][0] as Pharmacy).toProps();
    expect(saved).toMatchObject({
      transactingStatus: TransactingStatus.ACTIVE,
      licenseStatus: LicenseStatus.VALID,
      licenseExpiresAt: EXPIRES,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PHARMACY_ACTIVATED', context: expect.objectContaining({ verificationRequestId: 'req-1' }) }),
      'tx',
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
    expect(outbox.write).toHaveBeenCalledWith(
      expect.objectContaining({ type: PharmacyInventoryEventType.PharmacyActivated }),
      'tx',
    );
  });

  it('is a no-op for a pharmacy already active on the same licence', async () => {
    pharmacies.findByIdForUpdate.mockResolvedValue(
      pharmacy({ transactingStatus: TransactingStatus.ACTIVE, licenseExpiresAt: EXPIRES }),
    );
    await expect(activate()).resolves.toEqual({ activated: false });
    expectUntouched();
  });

  it('restores a pharmacy suspended for an expired licence once a newer licence is approved', async () => {
    pharmacies.findByIdForUpdate.mockResolvedValue(
      pharmacy({
        transactingStatus: TransactingStatus.SUSPENDED,
        licenseStatus: LicenseStatus.EXPIRED,
        licenseExpiresAt: new Date(Date.now() - 86_400_000),
      }),
    );
    await expect(activate()).resolves.toEqual({ activated: true });
    expect((pharmacies.update.mock.calls[0][0] as Pharmacy).toProps()).toMatchObject({
      transactingStatus: TransactingStatus.ACTIVE,
      licenseStatus: LicenseStatus.VALID,
      licenseExpiresAt: EXPIRES,
    });
  });

  it('404s for an unknown or deleted pharmacy', async () => {
    pharmacies.findByIdForUpdate.mockResolvedValue(null);
    await expect(activate()).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expectUntouched();
  });

  it('404s for a missing or deleted organisation', async () => {
    identity.getOrganization.mockResolvedValue(null);
    await expect(activate()).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expectUntouched();
  });

  it.each([
    ['another organisation type', { type: 'HOSPITAL' }, 'ORGANIZATION_NOT_PHARMACY'],
    ['PENDING_APPROVAL', { status: 'PENDING_APPROVAL' }, 'ORGANIZATION_NOT_ACTIVE'],
    ['REJECTED', { status: 'REJECTED' }, 'ORGANIZATION_NOT_ACTIVE'],
    ['SUSPENDED', { status: 'SUSPENDED' }, 'ORGANIZATION_NOT_ACTIVE'],
    ['no licence number', { licenseNumber: null }, 'LICENSE_MISSING'],
    ['no licence expiry', { licenseExpiresAt: null }, 'LICENSE_MISSING'],
  ])('refuses an organisation with %s', async (_label, overrides, reason) => {
    identity.getOrganization.mockResolvedValue(organization(overrides as Partial<OrganizationView>));
    await expect(activate()).rejects.toMatchObject({ code: ErrorCode.PHARMACY_NOT_ELIGIBLE, details: expect.objectContaining({ reason }) });
    expectUntouched();
  });

  it('refuses an expired licence, including one expiring exactly now', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-01T00:00:00.000Z') });
    try {
      for (const licenseExpiresAt of [new Date('2026-10-31T00:00:00.000Z'), new Date('2026-11-01T00:00:00.000Z')]) {
        identity.getOrganization.mockResolvedValue(organization({ licenseExpiresAt }));
        await expect(activate()).rejects.toMatchObject({ code: ErrorCode.LICENSE_EXPIRED });
      }
    } finally {
      jest.useRealTimers();
    }
    expectUntouched();
  });

  it.each<[string, ApprovedPharmacyLicenseView | null]>([
    ['no approved licence request', null],
    ['a different licence number', licence({ licenseNumber: 'LIC-2' })],
    ['a different expiry', licence({ expiresAt: new Date(EXPIRES.getTime() + 1000) })],
    ['another organisation', licence({ organizationId: 'org-2' })],
    ['another applicant than the owner', licence({ userId: 'someone-else' })],
  ])('refuses evidence with %s', async (_label, evidence) => {
    identity.getCurrentPharmacyLicense.mockResolvedValue(evidence);
    await expect(activate()).rejects.toMatchObject({
      code: ErrorCode.PHARMACY_NOT_ELIGIBLE,
      details: expect.objectContaining({ reason: 'LICENSE_NOT_APPROVED' }),
    });
    expectUntouched();
  });
});
