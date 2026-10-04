import { IsUUID } from 'class-validator';

/**
 * `GET /delivery/quote`'s query string (§9.2).
 *
 * ## Two identifiers, and nothing that could be a price
 *
 * There is no `distanceMeters`, no `deliveryFee`, no `lat`/`lng` and no `pharmacyId`. That is the
 * enforcement of §2 and §4 rather than a comment about them: the global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so a client that appends `&deliveryFee=0` gets a `400` naming the
 * property rather than a quote that quietly honoured it. Every number in the answer is resolved
 * server-side from these two ids.
 *
 * `pharmacyId` is absent for the same reason it is absent from the job-creation path: a branch
 * already belongs to exactly one pharmacy, and accepting both would create a pair that could
 * disagree. The answer reports which pharmacy the branch belongs to.
 *
 * ## Why the pair is an address and a branch
 *
 * Because those are the two things a customer has actually chosen at the moment they want to know
 * what delivery costs — their saved address, and one of the pharmacies matching ranked for them.
 * No order exists yet, no fulfillment exists yet and no delivery job exists yet; a quote that
 * required any of them could not be asked at checkout, which is the one time it matters (§3).
 *
 * `@IsUUID()` on both, because both are UUID primary keys in their owning modules and a malformed
 * id should be a validation error rather than a database round-trip that answers `NOT_FOUND` and
 * teaches a caller nothing.
 */
export class DeliveryQuoteDto {
  /** A Module 02 address id. Must belong to the authenticated customer — enforced server-side. */
  @IsUUID()
  addressId!: string;

  /** The Module 04 branch the goods would be collected from. */
  @IsUUID()
  branchId!: string;
}
