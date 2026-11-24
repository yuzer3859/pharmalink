import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Work 155: which of the caller's organisations a request works in.
 *
 * A pharmacy owner may hold several pharmacies, and a pharmacist may work at more than one. Every
 * module decides "the caller's pharmacy" from the organisations they hold a role in
 * (`getUserOrganizationIds`), and before this took the first. The pharmacy portal now sends the
 * chosen one in this header; each module's lookup keeps only that organisation — or none, when the
 * caller holds no role there, so naming someone else's pharmacy reaches nothing. Without the
 * header, nothing changes.
 */
export const SELECTED_ORGANIZATION_HEADER = 'x-organization-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storage = new AsyncLocalStorage<{ organizationId: string | null }>();

/** The organisation this request chose, or null when it chose none (or sent something else). */
export function selectedOrganization(): string | null {
  return storage.getStore()?.organizationId ?? null;
}

/** The caller's organisations, narrowed to the chosen one when the request chose one. */
export function narrowToSelectedOrganization(organizationIds: string[]): string[] {
  const chosen = selectedOrganization();
  return chosen ? organizationIds.filter((id) => id.toLowerCase() === chosen) : organizationIds;
}

/** Runs the rest of the request with the chosen organisation available to `selectedOrganization()`. */
export function runWithSelectedOrganization<T>(organizationId: string | null, fn: () => T): T {
  return storage.run({ organizationId: organizationId && UUID.test(organizationId) ? organizationId.toLowerCase() : null }, fn);
}

@Injectable()
export class SelectedOrganizationMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const raw = req.header(SELECTED_ORGANIZATION_HEADER);
    runWithSelectedOrganization(typeof raw === 'string' ? raw.trim() : null, next);
  }
}
