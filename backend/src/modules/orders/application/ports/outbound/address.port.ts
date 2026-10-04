export const ADDRESS_PORT = Symbol('ORDERS_ADDRESS_PORT');

/** Only the fields checkout actually needs (§5): `lat`/`lng` for Module 05's matching-distance
 * input, `line1`/`city` for `Order.addressSnapshot` (§3.10's `AddressSnapshot` shape). */
export interface AddressView {
  lat: number | null;
  lng: number | null;
  line1: string | null;
  city: string | null;
}

/**
 * Cross-module read port into Module 02 — Profiles (module-06 `06-orders-spec.md` §5, new for
 * Module 06 — no prior module has needed address resolution). Own copy per ADR-002, mirroring
 * `ICatalogPort`'s own-copy discipline: Module 02 exports nothing today (same situation Module 03
 * was already in for Modules 04/05), so this module builds its own adapter rather than importing
 * one. Backed by a direct, same-database `PrismaService` read of Module 02's `Address` model in
 * the infrastructure layer (`infrastructure/address/`, not built by this task) — never a Prisma
 * relation (ADR-002).
 *
 * Ownership-checked in the same call (`customerUserId` must own `addressId`) — this port never
 * returns another customer's address, mirroring the explicit-actor discipline
 * `ICheckRxGatePort.check()`'s `customerUserId`/`IDispensingPort.dispense()`'s
 * `dispensedByUserId` already establish (module-05 §10.4). Used by `/checkout/quote` and
 * `/checkout` (§9.2) to resolve `addressId` before calling Module 05's matching capability and to
 * populate `Order.addressSnapshot` (§3.3/§3.10) at placement time. Does not handle
 * `Beneficiary` — that dependency remains unimplemented in Module 02 and is out of scope for
 * Slice 1 (§0.2, §13.4).
 */
export interface IAddressPort {
  getAddress(addressId: string, customerUserId: string): Promise<AddressView | null>;
}
