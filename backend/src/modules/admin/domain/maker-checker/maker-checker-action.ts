import { Injectable } from '@nestjs/common';
import { ApprovalEntityType } from './approval-request';

/** Who is running an action, and under which key. */
export interface MakerCheckerExecutionContext {
  /** The approval request, or `null` when the action ran at once (not configured for approval). */
  approvalId: string | null;
  /**
   * The key the owning module must use for its own idempotency (BRULE-25). `approval:<id>` for
   * an approved request, so a resumed execution repeats nothing; the maker's own key otherwise.
   */
  idempotencyKey: string;
  makerUserId: string;
  /** The administrator whose authority runs the action: the checker, or the maker when no approval is needed. */
  actorUserId: string;
  actorPermissions: readonly string[];
}

/**
 * One sensitive action an owning module puts behind maker-checker.
 *
 * Registered by that module's adapter (Works 83, 84), never written in Admin: `execute` calls the
 * owning module's own command or port, so the module's transaction, rules and idempotency apply
 * exactly as they would to a single-actor call. Admin orchestrates; it never reaches into the
 * module's tables.
 */
export interface MakerCheckerAction<P extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable name, e.g. `SETTLEMENT_PAYOUT`. Listed in `approvals.makerCheckerActions` to require a checker. */
  type: string;
  entityType: ApprovalEntityType;
  /** Both the maker and the checker must hold it. */
  requiredPermission: string;
  /**
   * Validates the maker's payload and describes it for the checker, in one line. Throws an
   * `ApiException` for a payload the action could never run, so a bad request is refused before
   * anyone is asked to approve it.
   */
  describe(payload: P): { entityId: string; summary: string };
  /**
   * Work 84: whether *this* request needs a checker, when the action is listed. Absent = every
   * request does. A high-value refund answers by its amount against the threshold.
   */
  needsApproval?(payload: P): Promise<boolean>;
  /** Runs the action through the owning module. Returns what the checker should see as the outcome. */
  execute(payload: P, context: MakerCheckerExecutionContext): Promise<Record<string, unknown>>;
}

/**
 * The registered actions, by type.
 *
 * Registration is explicit (`register` from an owning module's `onModuleInit`) rather than
 * discovered, so the set of actions that can ever run through an approval is a list someone wrote.
 */
@Injectable()
export class MakerCheckerActionRegistry {
  private readonly actions = new Map<string, MakerCheckerAction>();

  register(action: MakerCheckerAction): void {
    if (this.actions.has(action.type)) {
      throw new Error(`Maker-checker action ${action.type} is already registered.`);
    }
    this.actions.set(action.type, action);
  }

  find(type: string): MakerCheckerAction | null {
    return this.actions.get(type) ?? null;
  }

  types(): string[] {
    return [...this.actions.keys()].sort();
  }
}
