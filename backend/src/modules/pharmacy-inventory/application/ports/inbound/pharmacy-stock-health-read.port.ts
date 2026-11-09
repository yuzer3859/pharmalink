export const PHARMACY_STOCK_HEALTH_READ_PORT = Symbol('PHARMACY_STOCK_HEALTH_READ_PORT');

/** Below this many sellable units an enabled listing counts as low stock (the portal's own threshold). */
export const LOW_STOCK_THRESHOLD = 10;
/** A batch with stock left that expires within this many days counts as expiring soon. */
export const EXPIRING_SOON_DAYS = 30;

export interface PharmacyStockHealth {
  listings: number;
  enabledListings: number;
  /** Enabled listings with nothing sellable. */
  outOfStock: number;
  /** Enabled listings with 1 to `LOW_STOCK_THRESHOLD - 1` sellable. */
  lowStock: number;
  /** Batches with stock left expiring within `EXPIRING_SOON_DAYS`. */
  batchesExpiringSoon: number;
  /** Batches with stock left already past expiry. */
  batchesExpired: number;
}

/**
 * Work 115: stock health for the pharmacy dashboard (module-04 §9.1 "stock health",
 * FR-PRV-08), over the given pharmacies' live (not deleted) listings. Read-only.
 */
export interface IPharmacyStockHealthReadPort {
  summarize(pharmacyIds: string[], now?: Date): Promise<PharmacyStockHealth>;
}
