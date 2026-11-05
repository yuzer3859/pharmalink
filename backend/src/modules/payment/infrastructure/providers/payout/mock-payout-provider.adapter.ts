import { Injectable } from '@nestjs/common';
import {
  IPayoutProviderPort,
  PayoutOutcome,
  PayoutRequest,
  PayoutResult,
} from '../../../application/ports/outbound/payout-provider.port';

/**
 * A deterministic payout rail for development, staging and tests (Work 83). **Never a production
 * adapter**: `PayoutProviderSelector` binds it only outside `NODE_ENV=production`, the same rule
 * `MockPaymentProvider` follows on the collection side. No money moves.
 *
 * Outcomes are chosen by the beneficiary's account identifier, so a walk can exercise every branch:
 *
 * - ends in `0000` → `FAILED` (a positive decline; no money moved);
 * - ends in `9999` → `UNKNOWN` on `pay`, then `PAID` on `getStatus` (an ambiguous outcome later
 *   confirmed);
 * - anything else → `PAID`.
 *
 * Idempotent on `reference` within the process: a repeated `pay` answers `ALREADY_PAID`.
 */
@Injectable()
export class MockPayoutProvider implements IPayoutProviderPort {
  readonly key = 'mock-payout';
  private readonly ledger = new Map<string, PayoutResult>();

  isAvailable(): boolean {
    return true;
  }

  async pay(request: PayoutRequest): Promise<PayoutResult> {
    const previous = this.ledger.get(request.reference);
    if (previous) {
      return previous.outcome === PayoutOutcome.PAID
        ? { ...previous, outcome: PayoutOutcome.ALREADY_PAID }
        : previous;
    }
    const identifier = request.beneficiary.accountIdentifier;
    const result: PayoutResult = identifier.endsWith('0000')
      ? { outcome: PayoutOutcome.FAILED, failureReason: 'Mock rail: account declined the transfer.' }
      : identifier.endsWith('9999')
        ? { outcome: PayoutOutcome.UNKNOWN }
        : { outcome: PayoutOutcome.PAID, providerReference: `MOCKPAYOUT-${request.reference}` };
    this.ledger.set(request.reference, result);
    return result;
  }

  async getStatus(reference: string): Promise<PayoutResult> {
    const known = this.ledger.get(reference);
    if (!known) {
      // A reference this process never saw (e.g. after a restart): the mock confirms it, which is the
      // only branch a real rail's status endpoint could answer for a transfer it executed.
      return { outcome: PayoutOutcome.PAID, providerReference: `MOCKPAYOUT-${reference}` };
    }
    if (known.outcome === PayoutOutcome.UNKNOWN || known.outcome === PayoutOutcome.PENDING) {
      const confirmed = { outcome: PayoutOutcome.PAID, providerReference: `MOCKPAYOUT-${reference}` };
      this.ledger.set(reference, confirmed);
      return confirmed;
    }
    return known;
  }
}
