export const IDENTITY_CONTACT_READ_PORT = Symbol('IDENTITY_CONTACT_READ_PORT');

/** Why a user cannot be reached on a channel. */
export type ContactUnavailableReason = 'UNKNOWN_USER' | 'INACTIVE' | 'NO_PHONE' | 'NO_EMAIL' | 'UNVERIFIED';

export type SmsContact =
  | { available: true; phone: string }
  | { available: false; reason: Exclude<ContactUnavailableReason, 'NO_EMAIL'> };

export type EmailContact =
  | { available: true; email: string }
  | { available: false; reason: Exclude<ContactUnavailableReason, 'NO_PHONE'> };

/**
 * Module 01's exported contract for **where one user can be reached** outside the app, consumed
 * in-process by Module 13's SMS (Work 15) and e-mail (Work 16) channels.
 *
 * Each answer is the account's own identifier — `users.phone` (E.164, verified by OTP) or
 * `users.email` (lowercased, verified by OTP) — and only when it can be used: the account exists,
 * is not deleted, deactivated or pending erasure, and that identifier is present and verified.
 * Otherwise a reason, never a fallback. One reachability rule for both channels. Nothing else
 * crosses this seam: no name, role, credential, Fayda value or the other identifier, and Module
 * 02's profile data (`secondaryPhone`) is not consulted.
 *
 * The phone or address is for immediate use by the caller; it must not be stored, logged or
 * returned.
 */
export interface IIdentityContactReadPort {
  smsRecipientOf(userId: string): Promise<SmsContact>;
  emailRecipientOf(userId: string): Promise<EmailContact>;
}
