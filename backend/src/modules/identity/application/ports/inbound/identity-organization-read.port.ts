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

/**
 * Work 153: who an organisation is — its registration, licence, owner and the people holding a
 * role in it — for the Super Admin's pharmacy record. Read-only.
 */
export interface IIdentityOrganizationReadPort {
  /** `null` when there is no live organisation with this id. */
  getOrganizationPeople(organizationId: string): Promise<OrganizationPeopleView | null>;
}
