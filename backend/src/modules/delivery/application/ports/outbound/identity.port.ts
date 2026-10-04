export const IDENTITY_PORT = Symbol('DELIVERY_IDENTITY_PORT');

/**
 * Why a driver is or is not operationally eligible.
 *
 * A reason rather than a bare boolean, because the three ways to fail need three different
 * responses from the driver app — finish onboarding, wait for review, contact support — and
 * because an operator looking at an audit entry or a refusal needs to know which one happened.
 */
export type DriverIneligibilityReason =
  /** Module 01 has no such user. */
  | 'USER_NOT_FOUND'
  /** The account exists but is not a driver account. */
  | 'NOT_A_DRIVER'
  /** Suspended, locked, pending verification, or soft-deleted — see `AccountSuspended` (§13's
   * catalogue lists Module 08 as a consumer: "halt/resume"). */
  | 'ACCOUNT_NOT_ACTIVE'
  /** No `DRIVER_DOCS` request has ever been approved. */
  | 'DOCUMENTS_NOT_APPROVED'
  /** A `DRIVER_DOCS` approval existed and has passed its expiry (BRULE-08). */
  | 'DOCUMENTS_EXPIRED';

export interface DriverIdentityView {
  userId: string;
  /** BRULE-09's answer. `false` is always accompanied by a `reason`. */
  isEligible: boolean;
  reason: DriverIneligibilityReason | null;
  /**
   * When the current `DRIVER_DOCS` approval lapses, where it carries one. Reported so the driver
   * app can warn before it happens; the eligibility decision has already accounted for it.
   */
  documentsExpireAt: Date | null;
}

/**
 * Cross-module read port into Module 01 — Identity. **Own copy per ADR-002**, not an import of
 * Module 04/05/06/07's `IIdentityPort`: the shape is deliberately reused, the implementation is
 * not, and `IdentityModule` exports nothing this module could depend on.
 *
 * ## This port exists so that Module 08 does not keep a copy of the answer
 *
 * §8's Phase-0 `driver_profiles.is_verified` was described as a "mirror of Module 1". The
 * driver-operational-profile work drops that column and asks the question here instead, every
 * time it matters. The reason is not tidiness: a mirrored authorization fact lags, and this one
 * lags *open*. A driver whose `DRIVER_DOCS` approval is revoked or expires in Module 01 keeps
 * carrying medicines for as long as nobody notices the copy is stale — and nothing would notice,
 * because the copy looks right.
 *
 * The repository has no precedent for a cached authorization projection that would justify one
 * here. The projections it does have (ADR-011's search read-models) feed ranking, never a
 * permission decision.
 *
 * ## One question, asked at one moment
 *
 * Eligibility is checked when a driver goes `ONLINE` — the moment they become dispatchable. It is
 * deliberately *not* re-checked on every location report (that would put a two-table read on a
 * ten-second-per-driver path for an answer that cannot change between fixes) and not on going
 * `OFFLINE` (refusing to let an unverified driver stop working would be absurd, and would strand
 * a driver whose documents lapsed mid-shift in a state they could not leave).
 *
 * A driver whose documents lapse *while* online stays online until their next transition. Closing
 * that window means reacting to Module 01's own `AccountSuspended`/verification events, which is
 * the dispatch work's to do — it is the component that would have to pull the driver out of
 * rotation and reassign their jobs (§11.5), and doing half of it here would leave jobs stranded.
 */
export interface IIdentityPort {
  /**
   * BRULE-09, answered live. **Fails closed**: a user Module 01 has no record of comes back
   * ineligible with `USER_NOT_FOUND`, never as an absent answer the caller might read as consent.
   */
  getDriverIdentity(userId: string): Promise<DriverIdentityView>;
}
