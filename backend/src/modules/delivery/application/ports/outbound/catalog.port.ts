export const CATALOG_PORT = Symbol('DELIVERY_CATALOG_PORT');

/**
 * Cross-module read port into Module 03 — Catalog
 * (`architecture/module-08-delivery-tracking.md` §5.3's "cold-chain jobs carry the flag from the
 * order/catalog"). Own copy per ADR-002 — `CatalogModule` exports nothing, so every consumer
 * builds its own adapter, exactly as Modules 04/05/06 did.
 *
 * One question, because Module 08 has exactly one: **does this job need cold-chain handling?**
 * (BRULE-30). The port deliberately does not return products, prices or classifications — a
 * delivery job carries no price and no Rx information, and a port that returned them would make
 * it easy for a later change to put them on the driver's screen.
 *
 * The flag has to come from here rather than from the order: `OrderLine.productSnapshot` records
 * only the product's name, so storage requirements are not in Module 06's copy at all.
 */
export interface ICatalogPort {
  /**
   * Which of `catalogProductIds` require cold-chain storage. Unknown or deleted products simply
   * do not appear — a product that cannot be read is not evidence that refrigeration is
   * unnecessary, but it is also not evidence that it is, and the creating command records what
   * the catalogue actually said rather than guessing in either direction.
   */
  findColdChainProductIds(catalogProductIds: string[]): Promise<string[]>;
}
