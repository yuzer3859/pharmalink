import { IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_HIGH_VALUE_REFUND_THRESHOLD,
  MAX_HIGH_VALUE_REFUND_THRESHOLD,
  MIN_HIGH_VALUE_REFUND_THRESHOLD,
} from '../../../../shared/config/approvals.config';

/** The maker-checker action type for a high-value manual refund (Work 84). */
export const HIGH_VALUE_REFUND_ACTION = 'REFUND_HIGH_VALUE';

/** `approvals.highValueRefundThreshold`, in minor units, or its default when absent or out of bounds. */
export function highValueRefundThreshold(config: IConfigPort | undefined): number {
  const raw = Number(config?.get<number>('approvals.highValueRefundThreshold'));
  return Number.isInteger(raw) && raw >= MIN_HIGH_VALUE_REFUND_THRESHOLD && raw <= MAX_HIGH_VALUE_REFUND_THRESHOLD
    ? raw
    : DEFAULT_HIGH_VALUE_REFUND_THRESHOLD;
}

/**
 * Whether a manual refund of `amountMinor` needs a second finance officer (Work 84): the action is
 * listed in `approvals.makerCheckerActions` **and** the amount is strictly above the threshold.
 * Read by both the refund command (which refuses a single-actor refund above it) and Admin's gate
 * (which then records a pending request), so the two can never disagree.
 */
export function refundNeedsSecondApproval(config: IConfigPort | undefined, amountMinor: number): boolean {
  const listed = config?.get<unknown>('approvals.makerCheckerActions');
  if (!Array.isArray(listed) || !listed.includes(HIGH_VALUE_REFUND_ACTION)) {
    return false;
  }
  return amountMinor > highValueRefundThreshold(config);
}
