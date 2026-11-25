import { VerificationType } from './enums';

/**
 * Work 160: the licences that belong to an organisation rather than a person, and the
 * organisation types each may license. A pharmacy licence (Work 67) licenses a PHARMACY; a
 * facility licence licenses a HOSPITAL, CLINIC or LAB (diagnostic centres are LAB organisations).
 * Both record a licence number and expiry on the organisation and make it ACTIVE when approved,
 * and suspend it when they expire.
 */
export const ORGANIZATION_LICENCE_TYPES: Readonly<Partial<Record<VerificationType, readonly string[]>>> = {
  [VerificationType.PHARMACY_LICENSE]: ['PHARMACY'],
  [VerificationType.FACILITY_LICENSE]: ['HOSPITAL', 'CLINIC', 'LAB'],
};

/** Every organisation type some organisation licence applies to. */
export const LICENSED_ORGANIZATION_TYPES = ['PHARMACY', 'HOSPITAL', 'CLINIC', 'LAB'] as const;

export function isOrganizationLicence(type: VerificationType | string): boolean {
  return Object.prototype.hasOwnProperty.call(ORGANIZATION_LICENCE_TYPES, type);
}

/** Whether a licence of this type may license an organisation of this type. */
export function licenceFitsOrganization(type: VerificationType | string, organizationType: string): boolean {
  return (ORGANIZATION_LICENCE_TYPES[type as VerificationType] ?? []).includes(organizationType);
}
