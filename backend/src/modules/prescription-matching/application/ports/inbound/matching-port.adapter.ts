import { Injectable } from '@nestjs/common';
import { FindMatchCommand } from '../../commands/find-match.command';
import { RematchCommand } from '../../commands/rematch.command';
import { SelectMatchCommand } from '../../commands/select-match.command';
import {
  IMatchingPort,
  MatchingFindInput,
  MatchingFindResult,
  MatchingRematchInput,
  MatchingRematchResult,
  MatchingSelectInput,
  MatchingSelectResult,
} from './matching.port';

/**
 * Implements `IMatchingPort` (module-05 §3.10/§8.3/§12; module-06 `06-orders-spec.md` §13.1
 * Option B) as a thin facade over the existing, already-tested `FindMatchCommand`/
 * `SelectMatchCommand`/`RematchCommand` — each port method is a 1:1, unmodified delegation to
 * the corresponding command's `execute()`. No ranking, reservation, state-transition, retry
 * (`runWithMatchRetry`), audit, outbox, or ADR-014 ordering logic is duplicated here; all of it
 * remains exactly where it already lives. This mirrors the "adapter that owns no business logic
 * of its own" shape of `infrastructure/catalog/catalog-port.adapter.ts` /
 * `infrastructure/availability/availability-port.adapter.ts`, applied here to an *inbound* port
 * instead of an outbound one — the only reason a separate facade class exists at all (rather
 * than a command directly `implements IMatchingPort`, as `CheckRxGateCommand`/
 * `DispenseMedicineCommand` do for their single-method ports) is that `IMatchingPort` unifies
 * three previously-separate commands under one exported token; there is no single existing class
 * that could implement it without this facade.
 */
@Injectable()
export class MatchingPortAdapter implements IMatchingPort {
  constructor(
    private readonly findMatchCommand: FindMatchCommand,
    private readonly selectMatchCommand: SelectMatchCommand,
    private readonly rematchCommand: RematchCommand,
  ) {}

  find(input: MatchingFindInput): Promise<MatchingFindResult> {
    return this.findMatchCommand.execute(input);
  }

  select(input: MatchingSelectInput): Promise<MatchingSelectResult> {
    return this.selectMatchCommand.execute(input);
  }

  rematch(input: MatchingRematchInput): Promise<MatchingRematchResult> {
    return this.rematchCommand.execute(input);
  }
}
