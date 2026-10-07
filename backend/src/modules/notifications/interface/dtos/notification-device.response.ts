import { DeviceTokenView } from '../../domain/repositories/device-token.repository';

/** A device registration as its owner sees it. The raw token is never returned — only its tail. */
export interface NotificationDeviceResponse {
  id: string;
  platform: string;
  /** `…` and the token's last six characters. */
  maskedToken: string;
  lastSeenAt: string | null;
  createdAt: string;
}

// Explicit allow-list, never a spread.
export function toNotificationDeviceResponse(d: DeviceTokenView): NotificationDeviceResponse {
  return {
    id: d.id,
    platform: d.platform,
    maskedToken: `…${d.tokenSuffix}`,
    lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
    createdAt: d.createdAt.toISOString(),
  };
}
