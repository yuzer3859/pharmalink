export const CATALOG_PORT = Symbol('CATALOG_PORT');

export interface CatalogProductView {
  id: string;
  type: string;
  status: string;
  rxClassification: string | null;
  controlledSchedule: string;
  onlineSaleProhibited: boolean;
  storageRequirement: string;
  /** Work 111: the display name (English, else generic, else brand); optional so earlier fakes stand. */
  name?: string | null;
}

/**
 * Cross-module read port into Module 03 — Catalog (module-04 §2). Backed by an in-process,
 * same-database adapter (`infrastructure/catalog/catalog-port.adapter.ts`) — never a Prisma
 * relation (ADR-002).
 */
export interface ICatalogPort {
  getProduct(productId: string): Promise<CatalogProductView | null>;
}
