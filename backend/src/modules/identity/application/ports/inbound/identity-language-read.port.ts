import { PreferredLanguage } from '../../../domain/enums';

export const IDENTITY_LANGUAGE_READ_PORT = Symbol('IDENTITY_LANGUAGE_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 01's domain layer. */
export { PreferredLanguage } from '../../../domain/enums';

/**
 * Module 01's exported contract for **one user's preferred language**, consumed in-process by
 * Module 13 to render a notification in the recipient's language (module-13 Work 01).
 *
 * One field, one user, read-only. Module 01 stays the owner of `users.preferredLanguage`; the
 * consumer keeps no copy and receives no other column — no contact detail, status, role or
 * credential crosses this seam.
 */
export interface IIdentityLanguageReadPort {
  /** The user's stored `preferredLanguage`, or `null` when no such user exists. */
  preferredLanguageOf(userId: string): Promise<PreferredLanguage | null>;
}
