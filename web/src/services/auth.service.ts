import type { AuthUser, PermissionKey, PortalKey } from '@/types';
import { ApiError, apiClient, type ApiRequestOptions } from './apiClient';

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export interface LoginCredentials {
  identifier: string;
  password: string;
  portal?: PortalKey;
}

export interface OtpCredentials {
  identifier: string;
  code: string;
  portal?: PortalKey;
}

interface BackendRole {
  roleKey: string;
  organizationId: string | null;
}

interface BackendCurrentUser {
  id: string;
  phone: string | null;
  email: string | null;
  primaryRole: string;
  status: string;
  preferredLanguage: string;
  phoneVerifiedAt: string | null;
  emailVerifiedAt: string | null;
  faydaVerified: boolean;
  deletionRequestedAt: string | null;
  roles: BackendRole[];
  permissions: string[];
}

interface VerifyOtpResponse {
  verified: true;
  tokens?: Record<string, unknown>;
}

const SESSION_STORAGE_KEY = 'pharmalink.auth';
const LEGACY_SESSION_STORAGE_KEY = 'pharmalink.session';
const DEVICE_STORAGE_KEY = 'pharmalink.device';

const ALL_PORTAL_PERMISSIONS: PermissionKey[] = [
  'dashboard:view',
  'inventory:view',
  'inventory:manage',
  'orders:view',
  'orders:manage',
  'analytics:view',
  'reports:view',
  'reports:export',
  'staff:view',
  'staff:manage',
  'roles:view',
  'roles:manage',
  'pharmacies:view',
  'pharmacies:manage',
  'audit:view',
  'settings:manage',
];

const ROLE_NAMES: Record<string, string> = {
  ADMIN: 'Operations Admin',
  SUPER_ADMIN: 'Super Administrator',
  PHARMACY_OWNER: 'Pharmacy Owner',
  PHARMACY_MANAGER: 'Pharmacy Manager',
  PHARMACIST: 'Pharmacist',
  CASHIER: 'Cashier',
  INVENTORY_STAFF: 'Inventory Staff',
};

const PHARMACY_ROLES = new Set([
  'PHARMACY_OWNER',
  'PHARMACY_MANAGER',
  'PHARMACIST',
  'CASHIER',
  'INVENTORY_STAFF',
]);

interface StoredSession {
  tokens: AuthTokens;
}

let session: StoredSession | null = readStoredSession();
let refreshPromise: Promise<string | null> | null = null;
const sessionExpiryListeners = new Set<() => void>();

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStoredSession(): StoredSession | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.tokens)) return null;
    return { tokens: normalizeTokens(parsed.tokens) };
  } catch {
    storage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

function persistSession(): void {
  const storage = getStorage();
  if (!storage) return;
  if (session) storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  else storage.removeItem(SESSION_STORAGE_KEY);
  storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
}

function clearStoredSession(): void {
  session = null;
  persistSession();
}

function setTokens(rawTokens: unknown): AuthTokens {
  const tokens = normalizeTokens(rawTokens);
  session = { tokens };
  persistSession();
  return tokens;
}

function normalizeTokens(value: unknown): AuthTokens {
  if (!isRecord(value)) {
    throw new ApiError(502, 'AUTH_RESPONSE_INVALID', 'The authentication service returned an invalid session.');
  }

  const accessToken = typeof value.accessToken === 'string' ? value.accessToken : null;
  const refreshToken = typeof value.refreshToken === 'string' ? value.refreshToken : null;
  if (!accessToken || !refreshToken) {
    throw new ApiError(502, 'AUTH_RESPONSE_INVALID', 'The authentication service returned an invalid session.');
  }

  const accessTokenExpiresAt =
    typeof value.accessTokenExpiresAt === 'number'
      ? value.accessTokenExpiresAt
      : typeof value.expiresIn === 'number'
        ? Math.floor(Date.now() / 1000) + value.expiresIn
        : 0;
  const refreshTokenExpiresAt =
    typeof value.refreshTokenExpiresAt === 'string'
      ? value.refreshTokenExpiresAt
      : typeof value.refreshTokenExpiresAt === 'number'
        ? new Date(value.refreshTokenExpiresAt).toISOString()
        : '';

  return { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt };
}

function deviceInfo(): { fingerprint: string; platform: 'WEB'; name: string } {
  const storage = getStorage();
  let fingerprint = storage?.getItem(DEVICE_STORAGE_KEY) ?? '';
  if (!fingerprint) {
    const random =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    fingerprint = `web-${random}`;
    storage?.setItem(DEVICE_STORAGE_KEY, fingerprint);
  }

  return {
    fingerprint,
    platform: 'WEB',
    name: typeof navigator === 'undefined' ? 'Web browser' : navigator.userAgent.slice(0, 120),
  };
}

function roleKeys(currentUser: BackendCurrentUser): Set<string> {
  return new Set([currentUser.primaryRole, ...currentUser.roles.map((role) => role.roleKey)]);
}

function portalFor(currentUser: BackendCurrentUser): PortalKey {
  const roles = roleKeys(currentUser);
  if (roles.has('SUPER_ADMIN')) return 'superadmin';
  if (roles.has('ADMIN')) return 'admin';
  if ([...roles].some((role) => PHARMACY_ROLES.has(role))) return 'pharmacy';
  throw new ApiError(403, 'PORTAL_ACCESS_DENIED', 'This account is not provisioned for an operations portal.');
}

function frontendPermissions(currentUser: BackendCurrentUser, portal: PortalKey): PermissionKey[] {
  const grants = new Set(currentUser.permissions);
  if (grants.has('*')) return [...ALL_PORTAL_PERMISSIONS];

  const result = new Set<PermissionKey>(['dashboard:view']);
  const has = (...permissions: string[]) => permissions.some((permission) => grants.has(permission));

  if (portal === 'pharmacy') {
    if (has('catalog:manage:org', 'inventory:manage:org')) {
      result.add('inventory:view');
      result.add('inventory:manage');
    }
    if (has('order:read:org')) result.add('orders:view');
    if (has('order:fulfill:org')) {
      result.add('orders:view');
      result.add('orders:manage');
    }
    if (has('staff:manage:org')) {
      result.add('staff:view');
      result.add('staff:manage');
    }
    if (has('rbac:read')) result.add('roles:view');
    if (has('rbac:manage')) {
      result.add('roles:view');
      result.add('roles:manage');
    }
    if (has('settlement:read:org', 'finance:report:any')) result.add('reports:view');
    if (has('finance:report:any')) result.add('reports:export');
    if (has('order:read:org', 'inventory:manage:org')) result.add('analytics:view');
  }

  if (portal === 'admin') {
    if (has('provider:verify:any')) {
      result.add('pharmacies:view');
      result.add('pharmacies:manage');
    }
    if (has('order:read:org')) result.add('orders:view');
    if (has('order:fulfill:org')) result.add('orders:manage');
    if (has('inventory:manage:org')) {
      result.add('inventory:view');
      result.add('inventory:manage');
    }
    if (has('finance:report:any')) {
      result.add('reports:view');
      result.add('reports:export');
      result.add('analytics:view');
    }
    if (has('rbac:read')) result.add('roles:view');
    if (has('rbac:manage')) {
      result.add('roles:view');
      result.add('roles:manage');
    }
    if (has('audit:read:any')) result.add('audit:view');
    if (has('user:suspend:any', 'user:reactivate:any')) result.add('staff:view');
  }

  return ALL_PORTAL_PERMISSIONS.filter((permission) => result.has(permission));
}

function displayRole(currentUser: BackendCurrentUser): string {
  return ROLE_NAMES[currentUser.primaryRole] ?? currentUser.primaryRole.replace(/_/g, ' ');
}

function toAuthUser(currentUser: BackendCurrentUser): AuthUser {
  const portal = portalFor(currentUser);
  const pharmacyAssignment = currentUser.roles.find(
    (role) => PHARMACY_ROLES.has(role.roleKey) && role.organizationId,
  );
  const identifier = currentUser.email ?? currentUser.phone ?? currentUser.id;
  const name = currentUser.email?.split('@')[0] ?? currentUser.phone ?? 'PharmaLink user';
  const avatarColor = portal === 'pharmacy' ? '#00838f' : portal === 'admin' ? '#7b1fa2' : '#005662';

  return {
    id: currentUser.id,
    name,
    email: identifier,
    avatarColor,
    portal,
    roleName: displayRole(currentUser),
    permissions: frontendPermissions(currentUser, portal),
    pharmacyId: pharmacyAssignment?.organizationId ?? undefined,
  };
}

function isMfaChallenge(value: unknown): value is { mfaRequired: true; challengeId?: string } {
  return isRecord(value) && value.mfaRequired === true;
}

export class OtpRequiredError extends Error {
  readonly code = 'AUTH_MFA_REQUIRED';

  constructor(readonly identifier: string, readonly challengeId?: string) {
    super('A verification code is required to finish signing in.');
    this.name = 'OtpRequiredError';
  }
}

export class PortalAccessError extends Error {
  readonly code = 'PORTAL_ACCESS_DENIED';

  constructor(readonly portal: PortalKey) {
    super(`This account does not have access to the ${portal} portal.`);
    this.name = 'PortalAccessError';
  }
}

async function refreshAccessToken(): Promise<string | null> {
  if (!session) return null;
  if (refreshPromise) return refreshPromise;

  const refreshToken = session.tokens.refreshToken;
  refreshPromise = (async () => {
    try {
      const response = await apiClient.post<unknown>('/auth/token/refresh', { refreshToken });
      return setTokens(response).accessToken;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expireSession();
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function requestWithSession<T>(path: string, options: Omit<ApiRequestOptions, 'accessToken' | 'refresh' | 'onSessionExpired'> = {}): Promise<T> {
  return apiClient.request<T>(path, {
    ...options,
    accessToken: session?.tokens.accessToken,
    refresh: refreshAccessToken,
    onSessionExpired: expireSession,
  });
}

async function currentUser(): Promise<AuthUser> {
  const response = await requestWithSession<BackendCurrentUser>('/users/me', { method: 'GET' });
  return toAuthUser(response);
}

function expireSession(): void {
  const hadSession = session !== null;
  clearStoredSession();
  if (hadSession) sessionExpiryListeners.forEach((listener) => listener());
}

export function getAuthErrorMessage(error: unknown): string {
  if (error instanceof OtpRequiredError) return error.message;
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK_ERROR') return 'The authentication service is unavailable. Please try again.';
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Unable to complete authentication. Please try again.';
}

export const authService = {
  async login(credentials: LoginCredentials): Promise<AuthUser> {
    let response: unknown;
    try {
      response = await apiClient.post<unknown>('/auth/login', {
        identifier: credentials.identifier.trim(),
        password: credentials.password,
        deviceInfo: deviceInfo(),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'AUTH_MFA_REQUIRED') {
        const details = isRecord(error.details) ? error.details : {};
        const challengeId = typeof details.challengeId === 'string' ? details.challengeId : undefined;
        throw new OtpRequiredError(credentials.identifier.trim(), challengeId);
      }
      throw error;
    }

    if (isMfaChallenge(response)) {
      throw new OtpRequiredError(credentials.identifier.trim(), response.challengeId);
    }

    try {
      setTokens(response);
      return await currentUser();
    } catch (error) {
      clearStoredSession();
      throw error;
    }
  },

  async verifyOtp(credentials: OtpCredentials): Promise<AuthUser> {
    const response = await apiClient.post<VerifyOtpResponse>('/auth/verify-otp', {
      identifier: credentials.identifier.trim(),
      code: credentials.code,
      purpose: 'LOGIN',
      deviceInfo: deviceInfo(),
    });

    if (!response.tokens) {
      throw new ApiError(401, 'AUTH_MFA_REQUIRED', 'The verification code did not create a session.');
    }

    try {
      setTokens(response.tokens);
      return await currentUser();
    } catch (error) {
      clearStoredSession();
      throw error;
    }
  },

  async resendOtp(identifier: string): Promise<void> {
    await apiClient.post('/auth/resend-otp', { identifier: identifier.trim(), purpose: 'LOGIN' });
  },

  getCurrentUser(): Promise<AuthUser> {
    return currentUser();
  },

  async refreshSession(): Promise<AuthTokens | null> {
    if (!session) return null;
    await refreshAccessToken();
    return session?.tokens ?? null;
  },

  async restoreSession(): Promise<AuthUser | null> {
    if (!session) return null;
    try {
      return await currentUser();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        expireSession();
        return null;
      }
      throw error;
    }
  },

  async logout(): Promise<void> {
    const activeSession = session;
    if (!activeSession) return;

    try {
      await requestWithSession('/auth/logout', {
        method: 'POST',
        body: { refreshToken: activeSession.tokens.refreshToken },
      });
    } catch {
      return;
    } finally {
      clearStoredSession();
    }
  },

  clearSession(): void {
    clearStoredSession();
  },

  subscribeToSessionExpiry(listener: () => void): () => void {
    sessionExpiryListeners.add(listener);
    return () => sessionExpiryListeners.delete(listener);
  },

  getAccessToken(): string | null {
    return session?.tokens.accessToken ?? null;
  },

  getRefreshToken(): string | null {
    return session?.tokens.refreshToken ?? null;
  },

  getSession(): StoredSession | null {
    return session;
  },
};
