/**
 * Work 155: the pharmacy the portal works in, for someone who works in several (an owner of more
 * than one pharmacy, or a pharmacist at more than one). It is sent on every API request as
 * `X-Organization-Id`; the backend keeps only that pharmacy for the request. Remembered on this
 * device; none chosen means the backend's own default (the first one).
 */
const KEY = 'pharmalink.portal.organizationId';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let chosen: string | null = read();
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(KEY) ?? null;
    return value && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function selectedOrganizationId(): string | null {
  return chosen;
}

export function selectOrganization(organizationId: string | null): void {
  chosen = organizationId && UUID.test(organizationId) ? organizationId : null;
  try {
    if (chosen) globalThis.localStorage?.setItem(KEY, chosen);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Not remembered on this device; the choice still holds until the page reloads.
  }
  listeners.forEach((l) => l());
}

export function onOrganizationSelected(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
