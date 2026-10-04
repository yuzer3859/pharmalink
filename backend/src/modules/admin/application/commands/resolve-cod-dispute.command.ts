import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  COD_DISPUTE_ADMIN_PORT,
  CodDisputeResolutionResult,
  ICodDisputeAdminPort,
} from '../../../delivery/application/ports/inbound/cod-dispute-admin.port';

export const ADMIN_COD_DISPUTE_RESOLVED = 'ADMIN_COD_DISPUTE_RESOLVED';

export interface ResolveCodDisputeInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  disputeId: string;
  /** How it ended, in the operator's own words — the only field Module 08's contract takes. */
  resolutionNote: string | null;
  ip: string | null;
}

/**
 * `POST /admin/cod-disputes/:id/resolve` (module-16 §9.6, §11.4).
 *
 *     admin HTTP → PermissionsGuard(finance:settlement:any) → this command
 *       → ICodDisputeAdminPort.resolveDispute → Module 08 ManageCodDisputeCommand.resolve
 *           (OPEN → RESOLVED write-once, compare-and-set on status, replay of a matching
 *            conclusion / CONFLICT on a different one, DELIVERY_COD_DISPUTE_RESOLVED audit)
 *       → this module's audit entry for the admin action
 *
 * Nothing about the dispute's lifecycle, and nothing about the money, is decided here. Module 08
 * defines the one transition and refuses everything else; a correction, a ledger entry, a status
 * on the collection — none of those exist on this path because Module 08's own resolve creates
 * none (§11.4's "resolution actions" that move money remain Module 07's, and are not wired).
 *
 * Module 08's replay of an already-resolved dispute with the same note is a success with
 * `changed: false`, and is recorded as such — the administrator took the action, whatever the
 * state already was. A refusal writes nothing here.
 */
@Injectable()
export class ResolveCodDisputeCommand {
  constructor(
    @Inject(COD_DISPUTE_ADMIN_PORT) private readonly disputes: ICodDisputeAdminPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ResolveCodDisputeInput): Promise<CodDisputeResolutionResult> {
    const result = await this.disputes.resolveDispute({
      actorUserId: input.actorUserId,
      disputeId: input.disputeId,
      resolutionNote: input.resolutionNote,
    });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_COD_DISPUTE_RESOLVED,
      resourceType: 'CodDispute',
      resourceId: result.dispute.id,
      context: {
        disputeId: result.dispute.id,
        collectionId: result.collectionId,
        previousStatus: result.previousStatus,
        status: result.dispute.status,
        changed: result.changed,
        resolutionNote: result.dispute.resolutionNote,
        resolvedByUserId: result.dispute.resolvedByUserId,
        resolvedAt: result.dispute.resolvedAt?.toISOString() ?? null,
      },
      ip: input.ip,
    });

    return result;
  }
}
