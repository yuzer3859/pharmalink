export const DEVICE_TOKEN_REPOSITORY = Symbol('DEVICE_TOKEN_REPOSITORY');

/** The platforms a push token is registered for — Module 01's `DevicePlatform` values. */
export const DEVICE_PLATFORMS = ['ANDROID', 'IOS', 'WEB'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** A device registration as its owner sees it: never the raw token, only its last characters. */
export interface DeviceTokenView {
  id: string;
  platform: string;
  /** The token's final characters, for the owner to tell devices apart. */
  tokenSuffix: string;
  lastSeenAt: Date | null;
  createdAt: Date;
}

/** An active token, for the push provider only. Carries the raw token; never leaves infrastructure. */
export interface ActiveDeviceToken {
  id: string;
  token: string;
}

/**
 * Persistence port for push device tokens (module-13 Work 14), over `device_tokens`. A row is one
 * app install's FCM registration token: `token` is globally unique, `isActive = false` is revoked
 * or invalidated. Every user-facing method takes the owner, so ownership cannot be skipped.
 */
export interface IDeviceTokenRepository {
  /**
   * Registers `token` for `userId` — one `INSERT … ON CONFLICT (token) DO UPDATE`. A token already
   * registered (to this user or, after a device changed hands, to another) becomes this user's,
   * active again, with `lastSeenAt` refreshed: an install's token identifies the install, and the
   * account signed in on it now is the one it should receive pushes for.
   */
  register(userId: string, token: string, platform: DevicePlatform, now: Date): Promise<DeviceTokenView>;
  /** The user's active registrations, most recently seen first. */
  listActiveForUser(userId: string): Promise<DeviceTokenView[]>;
  /** Deactivates the user's registration. `false` when it does not exist or is someone else's. */
  deactivateForUser(id: string, userId: string): Promise<boolean>;
  /** Up to `limit` active tokens of the user, most recently seen first — for the push provider. */
  activeTokensForDelivery(userId: string, limit: number): Promise<ActiveDeviceToken[]>;
  /** Deactivates the given registrations (tokens the push service reported as permanently invalid). */
  deactivateByIds(ids: readonly string[]): Promise<void>;
}
