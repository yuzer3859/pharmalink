import type { GatedOutcome, PayoutBeneficiary, PayoutRail, SettlementPayoutView } from '@/types';
import { authService, type SessionRequest } from './auth.service';

/** A fresh key per user action; the server makes a repeated key a replay (BRULE-25). */
export const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export interface RegisterBeneficiaryInput {
  rail: PayoutRail;
  accountName: string;
  bankCode?: string;
  accountIdentifier: string;
}

/**
 * Settlement approval and payout (Work 83). Approve, pay and verify are maker-checker actions: by
 * default the answer is `MAKER_CHECKER_PENDING` and a different finance officer decides on the
 * Approvals page. The actor always comes from the session.
 */
export function createSettlementPayoutService(request: SessionRequest, key: () => string = newIdempotencyKey) {
  const enc = encodeURIComponent;
  const gated = (path: string, reason?: string) =>
    request<GatedOutcome>(path, {
      method: 'POST',
      headers: { 'Idempotency-Key': key() },
      body: reason?.trim() ? { reason: reason.trim() } : {},
    });
  return {
    payout: (settlementId: string) =>
      request<SettlementPayoutView>(`/admin/finance/settlements/${enc(settlementId)}/payout`, { method: 'GET' }),
    approve: (settlementId: string, reason?: string) => gated(`/admin/finance/settlements/${enc(settlementId)}/approve`, reason),
    pay: (settlementId: string, reason?: string) => gated(`/admin/finance/settlements/${enc(settlementId)}/pay`, reason),
    refresh: (settlementId: string) =>
      request<unknown>(`/admin/finance/settlements/${enc(settlementId)}/payout/refresh`, { method: 'POST', body: {} }),
    beneficiaries: (pharmacyId: string) =>
      request<{ items: PayoutBeneficiary[] }>(`/admin/finance/pharmacies/${enc(pharmacyId)}/payout-beneficiaries`, { method: 'GET' }),
    registerBeneficiary: (pharmacyId: string, input: RegisterBeneficiaryInput) =>
      request<PayoutBeneficiary>(`/admin/finance/pharmacies/${enc(pharmacyId)}/payout-beneficiaries`, {
        method: 'POST',
        body: {
          rail: input.rail,
          accountName: input.accountName.trim(),
          accountIdentifier: input.accountIdentifier.trim(),
          ...(input.rail === 'BANK_TRANSFER' && input.bankCode?.trim() ? { bankCode: input.bankCode.trim() } : {}),
        },
      }),
    verifyBeneficiary: (beneficiaryId: string, reason?: string) =>
      gated(`/admin/finance/payout-beneficiaries/${enc(beneficiaryId)}/verify`, reason),

    /**
     * Work 84: a manual refund (`finance:refund:any`). Carried out now at or below the high-value
     * threshold, otherwise `MAKER_CHECKER_PENDING`. No amount = everything still refundable.
     */
    refund: (paymentId: string, input: { amount?: number; reason: string; destination: 'ORIGINAL' | 'WALLET' }) =>
      request<GatedOutcome>(`/admin/finance/payments/${enc(paymentId)}/refunds`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key() },
        body: {
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          reason: input.reason.trim(),
          destination: input.destination,
        },
      }),
  };
}

export const settlementPayoutService = createSettlementPayoutService(authService.request);

/** What to tell the operator after a gated action. */
export function gatedMessage(result: GatedOutcome, done: string): string {
  return result.outcome === 'MAKER_CHECKER_PENDING'
    ? 'Sent for approval. A different finance officer must approve it on the Approvals page.'
    : done;
}
