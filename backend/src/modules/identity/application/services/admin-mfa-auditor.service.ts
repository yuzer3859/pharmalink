import { Inject, Injectable } from '@nestjs/common';
import { AuditService, RecordAuditParams } from '../../../../shared/audit/audit.service';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';

/** Rounds of the unit of work's own bounded Serializable retry, with jittered backoff between. */
const ROUNDS = 5;
const BACKOFF_MS = 20;

function isSerializationFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'P2034' || code === '40001' || code === '40P01';
}

/**
 * Standalone audit entries for administrator MFA (Work 66), outside any other transaction.
 *
 * The audit log is one hash chain, so concurrent appends serialize: of N simultaneous writers, one
 * wins per round. `AuditService.record` on its own makes a single attempt, and a burst of sign-in
 * attempts (several wrong codes at once, a burst of logins) would turn a rejected code into a 500.
 * These entries therefore run in the unit of work's Serializable retry, repeated for a few rounds
 * with jittered backoff so contenders stop colliding in lockstep. A failure that is not a
 * serialization conflict, or one that outlasts every round, still propagates: nothing is skipped.
 */
@Injectable()
export class AdminMfaAuditor {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async record(params: RecordAuditParams): Promise<void> {
    for (let round = 1; ; round += 1) {
      try {
        await this.uow.run((tx) => this.audit.record(params, tx), { isolation: 'serializable' });
        return;
      } catch (err) {
        if (round >= ROUNDS || !isSerializationFailure(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * round * (0.5 + Math.random())));
      }
    }
  }
}
