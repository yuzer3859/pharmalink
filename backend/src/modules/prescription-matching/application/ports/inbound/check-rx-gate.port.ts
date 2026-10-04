import { BlockedItem } from '../../../domain/services/prescription-gate';

export const CHECK_RX_GATE_PORT = Symbol('CHECK_RX_GATE_PORT');

/** Port method input (§5.3) — not an HTTP DTO, a port method input (§10.4). */
export interface CheckRxGateInput {
  customerUserId: string;
  /** Accepted, unenforced in Slice 1 (§2.2). */
  beneficiaryId?: string;
  items: Array<{ catalogProductId: string; quantity: number }>;
}

export interface CheckRxGateResult {
  allowed: boolean;
  blocked: BlockedItem[];
  usablePrescriptionLineIds: string[];
}

/**
 * This module's own exported inbound contract for the Rx checkout gate (module-05 §5.3, §10.4)
 * — consumed in-process by Module 06 (Orders, future) via Nest DI, never over HTTP, mirroring
 * Module 04's `IInventoryPort` precedent (§10.4's reasoning, reused verbatim from module-04
 * §10.3: routing through HTTP back into the same process adds latency and would require
 * inventing an internal-service-auth scheme that exists nowhere else in the codebase).
 * Implemented by an application-layer command (not built by this task) that fetches
 * `PrescriptionLineCandidate[]` via `IPrescriptionRepository`/`ICatalogPort` and delegates the
 * actual allow/block decision to the pure `PrescriptionGate` domain service (§3.9) — this port
 * is purely the orchestration seam, no gate logic lives here.
 */
export interface ICheckRxGatePort {
  check(input: CheckRxGateInput): Promise<CheckRxGateResult>;
}
