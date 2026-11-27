export const IDENTITY_ORGANIZATION_READ_PORT = Symbol('IDENTITY_ORGANIZATION_READ_PORT');

export interface OrganizationPersonView {
  userId: string;
  email: string | null;
  phone: string | null;
  /** The account's status (`ACTIVE`, `SUSPENDED`, …). */
  status: string;
}

export interface OrganizationMemberView extends OrganizationPersonView {
  /** The organisation roles this person holds here (`PHARMACY_OWNER`, `PHARMACIST`, …), sorted. */
  roles: string[];
  /** When their first role here was granted. */
  since: Date;
}

export interface OrganizationPeopleView {
  organizationId: string;
  name: string;
  type: string;
  status: string;
  licenseNumber: string | null;
  licenseExpiresAt: Date | null;
  /** When the organisation was registered. */
  createdAt: Date;
  owner: OrganizationPersonView;
  members: OrganizationMemberView[];
}

/** Work 157: a pharmacy owner and the organisations they own. */
export interface OwnerView extends OrganizationPersonView {
  /** When the account was created. */
  createdAt: Date;
  organizations: Array<{ organizationId: string; name: string; status: string }>;
}

/**
 * Work 153: who an organisation is — its registration, licence, owner and the people holding a
 * role in it — for the Super Admin's pharmacy record. Read-only.
 */
export interface IIdentityOrganizationReadPort {
  /** `null` when there is no live organisation with this id. */
  getOrganizationPeople(organizationId: string): Promise<OrganizationPeopleView | null>;
  /**
   * Work 157: everyone who owns a pharmacy organisation, newest first, each with what they own.
   * `identifier` is an exact e-mail (any case) or phone.
   */
  listOwners(filter: { identifier?: string; status?: string }, page: number, size: number): Promise<{ items: OwnerView[]; total: number }>;
  /** Work 157: one owner, or `null` when the account owns no pharmacy organisation. */
  getOwner(userId: string): Promise<OwnerView | null>;
  /**
   * Work 161: the live organisations where the user holds any of these organisation roles, oldest
   * role first — how a provider portal request finds "the caller's facility".
   */
  organizationIdsWhereUserHolds(userId: string, roleKeys: string[]): Promise<string[]>;
  /**
   * Work 166: an account by exact e-mail (any case) or phone, or `null`. Used where a person is
   * named by how they sign in, such as a facility adding one of its doctors.
   */
  findAccount(identifier: string): Promise<(OrganizationPersonView & { primaryRole: string }) | null>;
  /** Work 166: accounts by id (e-mail, phone, status), for showing who someone is. Missing ids are left out. */
  accountsById(userIds: string[]): Promise<Array<OrganizationPersonView & { primaryRole: string }>>;
}
