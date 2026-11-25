import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/** module-09 §5.2: what a healthcare provider is. */
export const PROVIDER_TYPES = ['HOSPITAL', 'CLINIC', 'DIAGNOSTIC_CENTER', 'LAB'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

/**
 * Work 160: the Module 01 organisation type behind each provider type. A diagnostic centre is a
 * LAB organisation (Module 01 has no separate type), licensed by the same facility licence.
 */
export function organizationTypeFor(type: ProviderType): 'HOSPITAL' | 'CLINIC' | 'LAB' {
  if (type === 'HOSPITAL') return 'HOSPITAL';
  if (type === 'CLINIC') return 'CLINIC';
  return 'LAB';
}

export const ProviderErrors = {
  notFound: () => new ApiException(ErrorCode.PROVIDER_NOT_FOUND, 'Healthcare provider not found.'),
  /**
   * The provider can't operate: its organisation is not ACTIVE, or it has no current approved
   * licence. `reason` says which.
   */
  notEligible: (reason: 'ORGANIZATION_NOT_FOUND' | 'ORGANIZATION_TYPE_MISMATCH' | 'NOT_OWNER' | 'ORGANIZATION_NOT_ACTIVE' | 'LICENSE_MISSING' | 'LICENSE_EXPIRED') =>
    new ApiException(ErrorCode.PROVIDER_NOT_ELIGIBLE, 'This healthcare provider is not eligible to operate.', { reason }),
  reasonRequired: () => ApiException.validation('Give a reason of 3 to 500 characters.', { field: 'reason' }),
};
