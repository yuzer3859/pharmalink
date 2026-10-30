import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AccountStatus, PrimaryRole } from '../../domain/enums';
import { IOrganizationRepository, OrganizationRecord } from '../../domain/repositories/organization.repository';
import { IUserRepository } from '../../domain/repositories/user.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { PermissionChangeService } from '../services/permission-change.service';
import { ApplyPharmacyOrganizationCommand, normalizeLegalName } from './apply-pharmacy-organization.command';

const CREATED_AT = new Date('2026-11-01T00:00:00.000Z');
const org = (overrides: Partial<OrganizationRecord> = {}): OrganizationRecord => ({
  id: 'org-1',
  type: 'PHARMACY',
  name: 'Abebe Pharmacy PLC',
  status: 'PENDING_APPROVAL',
  ownerUserId: 'user-1',
  applicationKey: 'key-12345678',
  createdAt: CREATED_AT,
  ...overrides,
});
const customer = {
  id: 'user-1',
  status: AccountStatus.ACTIVE,
  emailVerifiedAt: new Date(),
  primaryRole: PrimaryRole.CUSTOMER,
};

function build(user: unknown = customer) {
  const users = { findById: jest.fn().mockResolvedValue(user) } as unknown as jest.Mocked<IUserRepository>;
  const organizations = {
    findByOwnerAndApplicationKey: jest.fn().mockResolvedValue(null),
    findRoleByKey: jest.fn().mockResolvedValue({ id: 'role-owner', key: 'PHARMACY_OWNER', scope: 'ORG' }),
    createPendingPharmacy: jest.fn().mockResolvedValue(org()),
    addMembership: jest.fn().mockResolvedValue({ assignmentId: 'assignment-1' }),
  } as jest.Mocked<IOrganizationRepository>;
  const uow = {
    run: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work('tx')),
  } as unknown as jest.Mocked<IUnitOfWork>;
  const permissionChange = { propagate: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<PermissionChangeService>;
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as jest.Mocked<AuditService>;
  const command = new ApplyPharmacyOrganizationCommand(users, organizations, uow, permissionChange, audit);
  return { command, users, organizations, uow, permissionChange, audit };
}

const input = { actorUserId: 'user-1', legalName: '  Abebe   Pharmacy PLC ', idempotencyKey: 'key-12345678' };

async function apiError(promise: Promise<unknown>): Promise<ApiException> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiException);
  return err as ApiException;
}

describe('ApplyPharmacyOrganizationCommand', () => {
  it('creates a pending PHARMACY organisation and an org-scoped PHARMACY_OWNER membership for the caller', async () => {
    const m = build();
    const view = await m.command.execute(input);

    expect(m.organizations.createPendingPharmacy).toHaveBeenCalledWith(
      { ownerUserId: 'user-1', name: 'Abebe Pharmacy PLC', applicationKey: 'key-12345678' },
      'tx',
    );
    expect(m.organizations.addMembership).toHaveBeenCalledWith(
      { userId: 'user-1', roleId: 'role-owner', organizationId: 'org-1', assignedBy: 'user-1' },
      'tx',
    );
    expect(m.audit.record).toHaveBeenCalledTimes(2);
    expect(m.audit.record.mock.calls.map(([params]) => params.action)).toEqual([
      'identity.organization.pharmacy_application_created',
      'rbac.user_role.assigned',
    ]);
    expect(m.uow.run).toHaveBeenCalledWith(expect.any(Function), { isolation: 'serializable' });
    expect(m.permissionChange.propagate).toHaveBeenCalledWith(['user-1']);
    expect(view).toEqual({
      organizationId: 'org-1',
      type: 'PHARMACY',
      name: 'Abebe Pharmacy PLC',
      status: 'PENDING_APPROVAL',
      membership: { roleKey: 'PHARMACY_OWNER', organizationId: 'org-1' },
      createdAt: CREATED_AT,
    });
  });

  it.each([
    ['a missing account', null, 'ACCOUNT_NOT_ACTIVE'],
    ['a suspended account', { ...customer, status: AccountStatus.SUSPENDED }, 'ACCOUNT_NOT_ACTIVE'],
    ['a deactivated account', { ...customer, status: AccountStatus.DEACTIVATED }, 'ACCOUNT_NOT_ACTIVE'],
    ['an unverified e-mail', { ...customer, emailVerifiedAt: null }, 'EMAIL_NOT_VERIFIED'],
    ['a staff account', { ...customer, primaryRole: PrimaryRole.ADMIN }, 'NOT_A_CUSTOMER'],
  ])('refuses %s without writing', async (_label, user, reason) => {
    const m = build(user);
    const err = await apiError(m.command.execute(input));
    expect(err.code).toBe(ErrorCode.FORBIDDEN);
    expect(err.details).toEqual({ reason });
    expect(m.uow.run).not.toHaveBeenCalled();
    expect(m.permissionChange.propagate).not.toHaveBeenCalled();
  });

  it('fails closed when PHARMACY_OWNER is missing or not ORG-scoped', async () => {
    for (const role of [null, { id: 'r', key: 'PHARMACY_OWNER', scope: 'PLATFORM' }]) {
      const m = build();
      m.organizations.findRoleByKey.mockResolvedValue(role);
      const err = await apiError(m.command.execute(input));
      expect(err.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(m.organizations.createPendingPharmacy).not.toHaveBeenCalled();
      expect(m.permissionChange.propagate).not.toHaveBeenCalled();
    }
  });

  it('returns the existing application for a same-key retry with the same name, without writing', async () => {
    const m = build();
    m.organizations.findByOwnerAndApplicationKey.mockResolvedValue(org());
    await expect(m.command.execute(input)).resolves.toMatchObject({ organizationId: 'org-1' });
    expect(m.uow.run).not.toHaveBeenCalled();
    expect(m.organizations.findByOwnerAndApplicationKey).toHaveBeenCalledWith('user-1', 'key-12345678');
  });

  it('rejects the same key with a different name as IDEMPOTENCY_CONFLICT', async () => {
    const m = build();
    m.organizations.findByOwnerAndApplicationKey.mockResolvedValue(org({ name: 'Another Pharmacy' }));
    expect((await apiError(m.command.execute(input))).code).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
  });

  it('answers a concurrent duplicate (unique violation) as a retry of the winner', async () => {
    const m = build();
    m.uow.run.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    m.organizations.findByOwnerAndApplicationKey.mockResolvedValueOnce(null).mockResolvedValueOnce(org());
    await expect(m.command.execute(input)).resolves.toMatchObject({ organizationId: 'org-1' });
    expect(m.permissionChange.propagate).not.toHaveBeenCalled();
  });

  it('normalizes whitespace in the legal name', () => {
    expect(normalizeLegalName('  Abebe \t  Pharmacy\nPLC ')).toBe('Abebe Pharmacy PLC');
  });
});
