export const DRIVER_RECIPIENT_READ_PORT = Symbol('DRIVER_RECIPIENT_READ_PORT');

/**
 * Module 08's exported contract for **which person a driver profile belongs to**, consumed
 * in-process by Module 13 to address driver notifications (module-13 Work 05).
 *
 * Every Module 08 event names its driver by `driver_profiles.id` — deliberately, because Module 08
 * owns the operational driver and Module 01 owns the person. This answers the one question that
 * separates the two: `driver_profiles.userId`, the Module 01 `users.id` of the account the profile
 * belongs to. Nothing else crosses this seam — no vehicle, plate, service area, availability,
 * location or shift.
 */
export interface IDriverRecipientReadPort {
  /** The profile's Module 01 `users.id`, or `null` when no such driver profile exists. */
  userIdOf(driverProfileId: string): Promise<string | null>;
}
