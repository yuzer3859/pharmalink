import { FindMatchInput, FindMatchResult } from '../../commands/find-match.command';
import { SelectMatchInput } from '../../commands/select-match.command';
import { RematchInput } from '../../commands/rematch.command';
import { MatchRequestSnapshot } from '../../../domain/repositories/match.repository';

export const MATCHING_PORT = Symbol('MATCHING_PORT');

/** Re-exported verbatim from the existing, already-tested application commands (module-05 §3.10,
 * §8.3, §12) — this port does not define a second, parallel input/output shape (module-06
 * `06-orders-spec.md` §13.1's "do not invent a new identifier solely for convenience"). */
export type MatchingFindInput = FindMatchInput;
export type MatchingFindResult = FindMatchResult;
export type MatchingSelectInput = SelectMatchInput;
export type MatchingRematchInput = RematchInput;
export type MatchingSelectResult = MatchRequestSnapshot;
export type MatchingRematchResult = MatchRequestSnapshot;

/**
 * This module's own exported inbound contract for the matching capability (module-05 §3.10,
 * §8.3, §12; module-06 `06-orders-spec.md` §13.1 Option B) — consumed in-process by Module 06
 * (Orders, future) via Nest DI, never over HTTP, mirroring `ICheckRxGatePort`/`IDispensingPort`'s
 * existing inbound-port precedent (§10.4's reasoning) and Module 04's `IInventoryPort`.
 *
 * Deliberately exposes only the three capabilities module-06 `06-orders-spec.md` §4/§9.4
 * actually names as checkout-saga/decline-flow dependencies: `find` (checkout saga step 3),
 * `select` (checkout saga step 3+4 — `SelectMatchCommand` itself already reserves stock via
 * Module 04's `IInventoryPort` before flipping `MatchRequest.status`, per ADR-014; this port
 * calls that already-atomic sequence as one step, never re-implementing the ADR-014 ordering
 * here), and `rematch` (`DeclineFulfillmentCommand`'s re-match trigger, BRULE-19). `GetMatchResultQuery`
 * is deliberately **not** exposed here — no module-06 Slice-1 command needs to re-query Module
 * 05 for match status (an `Order`/`OrderLine` already snapshots the chosen result at placement
 * time, module-06 spec §3.7/§3.9) — adding it now would be exposing a capability no consumer
 * needs yet, the same "no speculative surface" discipline module-05 itself applied when it
 * declined to add a `clarify` outbox event with no cataloged consumer (§10.2 of that spec).
 *
 * Every method requires an explicit `customerUserId` — this port carries no ambient
 * "trusted internal caller" bypass of ownership scoping. A server-side Module 06 caller must
 * supply the actual order/cart's own `customerUserId`, exactly the same explicit-actor
 * discipline `ICheckRxGatePort.check()`'s `customerUserId` and `IDispensingPort.dispense()`'s
 * `dispensedByUserId` already establish — the port narrows *how* the capability is reached
 * (in-process vs. HTTP), never *who* it can be reached on behalf of.
 *
 * This port carries no ranking, reservation, state-transition, retry, or authorization logic
 * of its own — all of that remains owned by `FindMatchCommand`/`SelectMatchCommand`/
 * `RematchCommand` exactly as today; the port is purely the exported seam (implemented by
 * `MatchingPortAdapter`, a thin facade that delegates 1:1 to those existing commands — see
 * that file's doc comment).
 */
export interface IMatchingPort {
  find(input: MatchingFindInput): Promise<MatchingFindResult>;
  select(input: MatchingSelectInput): Promise<MatchingSelectResult>;
  rematch(input: MatchingRematchInput): Promise<MatchingRematchResult>;
}
