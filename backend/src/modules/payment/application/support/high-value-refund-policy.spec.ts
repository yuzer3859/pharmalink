import { DEFAULT_HIGH_VALUE_REFUND_THRESHOLD } from '../../../../shared/config/approvals.config';
import { PERMISSIONS_KEY } from '../../../../shared/rbac/permissions.decorator';
import { AdminRefundController } from '../../../admin/interface/controllers/admin-refund.controller';
import { HIGH_VALUE_REFUND_ACTION, highValueRefundThreshold, refundNeedsSecondApproval } from './high-value-refund-policy';

const config = (values: Record<string, unknown>) => ({
  get: (key: string) => values[key],
  getOrThrow: (key: string) => values[key],
  isFeatureEnabled: () => false,
});

describe('High-value refund policy (Work 84)', () => {
  it('defaults the threshold to 10,000 birr and ignores an out-of-bounds value', () => {
    expect(DEFAULT_HIGH_VALUE_REFUND_THRESHOLD).toBe(1_000_000);
    expect(highValueRefundThreshold(undefined)).toBe(1_000_000);
    expect(highValueRefundThreshold(config({ 'approvals.highValueRefundThreshold': 5_000 }) as never)).toBe(5_000);
    expect(highValueRefundThreshold(config({ 'approvals.highValueRefundThreshold': 0 }) as never)).toBe(1_000_000);
  });

  it('needs a second officer only when the action is listed and the amount is strictly above', () => {
    const on = config({ 'approvals.makerCheckerActions': [HIGH_VALUE_REFUND_ACTION], 'approvals.highValueRefundThreshold': 5_000 });
    expect(refundNeedsSecondApproval(on as never, 5_000)).toBe(false);
    expect(refundNeedsSecondApproval(on as never, 5_001)).toBe(true);
    const off = config({ 'approvals.makerCheckerActions': [], 'approvals.highValueRefundThreshold': 5_000 });
    expect(refundNeedsSecondApproval(off as never, 1_000_000_000)).toBe(false);
    expect(refundNeedsSecondApproval(undefined, 1_000_000_000)).toBe(false);
  });

  it('serves the admin refund route behind finance:refund:any', () => {
    expect(Reflect.getMetadata('path', AdminRefundController)).toBe('admin/finance/payments');
    expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminRefundController.prototype.refund)).toEqual(['finance:refund:any']);
  });
});
