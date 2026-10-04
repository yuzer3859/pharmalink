import { DevicePlatform, LoginOutcome } from '../enums';

export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');
export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');
export const DEVICE_REPOSITORY = Symbol('DEVICE_REPOSITORY');
export const LOGIN_HISTORY_REPOSITORY = Symbol('LOGIN_HISTORY_REPOSITORY');

// --- Refresh tokens (rotation + reuse detection, module-01 §7.5) ---------------------------

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  familyId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  replacedBy: string | null;
}

export interface NewRefreshToken {
  userId: string;
  deviceId: string | null;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

export interface IRefreshTokenRepository {
  create(data: NewRefreshToken, tx?: unknown): Promise<RefreshTokenRecord>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /** Mark a token consumed and link it to its successor (one-time-use rotation). */
  markUsed(id: string, replacedById: string, tx?: unknown): Promise<void>;
  /** Revoke every token in a rotation family (reuse/theft response). */
  revokeFamily(familyId: string, tx?: unknown): Promise<void>;
  /** Revoke all of a user's tokens (logout-all / password reset). */
  revokeAllForUser(userId: string, tx?: unknown): Promise<number>;
}

// --- Sessions --------------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface NewSession {
  userId: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  expiresAt: Date;
}

export interface ISessionRepository {
  create(data: NewSession, tx?: unknown): Promise<SessionRecord>;
  findById(id: string): Promise<SessionRecord | null>;
  revoke(id: string): Promise<void>;
  revokeAllForUser(userId: string, tx?: unknown): Promise<number>;
  listActiveForUser(userId: string): Promise<SessionRecord[]>;
}

// --- Devices ---------------------------------------------------------------------------------

export interface DeviceRecord {
  id: string;
  userId: string;
  fingerprint: string;
  name: string | null;
  platform: DevicePlatform;
  isTrusted: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface DeviceInfo {
  fingerprint: string;
  name?: string | null;
  platform: DevicePlatform;
  fcmToken?: string | null;
}

export interface IDeviceRepository {
  /** Find an existing device by (user, fingerprint) or create it. */
  upsertForUser(userId: string, info: DeviceInfo): Promise<DeviceRecord>;
  findById(id: string): Promise<DeviceRecord | null>;
  listForUser(userId: string): Promise<DeviceRecord[]>;
  /** Revokes the device and, transactionally, every refresh token bound to it. */
  revoke(id: string): Promise<void>;
}

// --- Login history ---------------------------------------------------------------------------

export interface LoginHistoryEntry {
  userId: string | null;
  identifier: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  outcome: LoginOutcome;
  failureReason?: string | null;
}

export interface LoginHistoryRecord extends LoginHistoryEntry {
  id: string;
  createdAt: Date;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface ILoginHistoryRepository {
  record(entry: LoginHistoryEntry): Promise<void>;
  listForUser(userId: string, page: number, size: number): Promise<PaginatedResult<LoginHistoryRecord>>;
}
