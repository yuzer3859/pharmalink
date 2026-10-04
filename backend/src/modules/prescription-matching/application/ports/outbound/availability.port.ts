export const AVAILABILITY_PORT = Symbol('AVAILABILITY_PORT');

/** One `(catalogProductId, pharmacy, listing)` availability row — the same per-line granularity as Module 04's `AvailabilityItem` (module-04 `application/queries/get-availability.query.ts`). */
export interface PharmacyAvailabilityCandidate {
  pharmacyId: string;
  branchId: string;
  listingId: string;
  price: number;
  currency: string;
  sellable: number;
  distanceMeters?: number;
}

/**
 * Read-side port into Module 04's availability query (module-05 §2.1) — Module 05 is the first
 * consumer of Module 04's `IInventoryPort`/availability read. Adapts
 * `GET /availability/product/:catalogProductId` (Module 04's `GetAvailabilityQuery`, module-04
 * §5.5/§10.3) via a direct, in-process Nest DI injection (importing `PharmacyInventoryModule`
 * and injecting `GetAvailabilityQuery` directly), never an HTTP round-trip — the adapter is not
 * built by this task (`infrastructure/availability/`).
 *
 * Deliberately named `PharmacyAvailabilityCandidate`, distinct from the domain's already-defined
 * `AvailabilityCandidate` (`domain/services/match-ranking-strategy.ts`): this port returns one
 * row per `(catalogProductId, pharmacy, listing)` — the same per-line granularity as Module 04's
 * `AvailabilityItem` — whereas the domain's `AvailabilityCandidate` is the *already-aggregated*,
 * one-row-per-pharmacy view that `MatchingEngine`/`FindMatchCommand` (§3.10, not built by this
 * task) is expected to build by calling `getAvailability` once per order line and
 * grouping/summing the per-line results across a pharmacy's coverage before handing them to
 * `MatchRankingStrategy.rank()`.
 *
 * `reserve()`/`release()` are deliberately **not** part of this port (§2.1) — Module 05 injects
 * Module 04's already-exported `IInventoryPort`
 * (`modules/pharmacy-inventory/application/ports/inbound/inventory.port.ts`) directly for those,
 * since re-wrapping an already-clean port in another port adds a layer with no behavioral
 * difference. This port only exists for the read side, whose shape (a ranking candidate list)
 * genuinely differs from the raw `AvailabilityItem[]`.
 */
export interface IAvailabilityPort {
  getAvailability(
    catalogProductId: string,
    geo?: { lat: number; lng: number },
  ): Promise<PharmacyAvailabilityCandidate[]>;
}
