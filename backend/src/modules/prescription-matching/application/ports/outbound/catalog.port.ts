export const CATALOG_PORT = Symbol('PRESCRIPTION_MATCHING_CATALOG_PORT');

export interface CatalogProductView {
  id: string;
  status: string;
  rxClassification: string | null;
}

/**
 * Cross-module read port into Module 03 — Catalog (module-05 §2.1). Own copy per ADR-002 — not
 * a cross-module import of `modules/pharmacy-inventory/application/ports/outbound/catalog.port.ts`,
 * even though the shape is reused from it (per §2.1: "own copy, reused shape from Module 04's
 * `CatalogProductView`"). Backed by a direct, same-database `PrismaService` read of `Product` in
 * the infrastructure layer (`infrastructure/catalog/`, not built by this task) — never a Prisma
 * relation (ADR-002).
 *
 * Used by `ApprovePrescriptionCommand` (validate a mapped `catalogProductId` resolves to a
 * non-deleted, `ACTIVE` product, §5.2 — otherwise `404 CATALOG_PRODUCT_NOT_FOUND`) and by the Rx
 * gate flow (does this product require a prescription, i.e. `rxClassification === 'RX'` — see
 * `RxClassificationPolicy`, §3.9/§8.2; **not** `!== null`, which would also catch `'OTC'`).
 */
export interface ICatalogPort {
  getProduct(productId: string): Promise<CatalogProductView | null>;
}
