export const IDENTITY_CONTACT_READ_PORT = Symbol('IDENTITY_CONTACT_READ_PORT');

/** Why a user cannot be reached by SMS. */
export type SmsContactUnavailableReason = 'UNKNOWN_USER' | 'INACTIVE' | 'NO_PHONE' | 'UNVERIFIED';

export type SmsContact =
  | { available: true; phone: string }
  | { available: false; reason: SmsContactUnavailableReason };

/**
 * Module 01's exported contract for **where one user can be texted**, consumed in-process by
 * Module 13's SMS channel (module-13 Work 15).
 *
 * The answer is the account's own phone — `users.phone`, the identifier Module 01 normalizes to
 * E.164 at registration and verifies by OTP — and only when it can be used: the account exists,
 * is not deleted or deactivated, and the phone is present and verified. Otherwise a reason, never
 * a fallback number. Nothing else crosses this seam: no e-mail, name, role, status detail or
 * credential, and Module 02's unverified `secondaryPhone` is not consulted.
 *
 * The phone is for immediate use by the caller; it must not be stored, logged or returned.
 */
export interface IIdentityContactReadPort {
  smsRecipientOf(userId: string): Promise<SmsContact>;
}
