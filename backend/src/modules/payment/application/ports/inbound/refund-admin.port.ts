export const REFUND_ADMIN_PORT = Symbol('REFUND_ADMIN_PORT');

/** A manual refund needs this permission (module-07 §9.3); both maker and checker hold it. */
export const FINANCE_REFUND_ADMIN_PERMISSION = 'finance:refund:any';

export interface RefundAdminRequest {
  paymentId: string;
  /** Omitted = everything still refundable (§9.3). */
  amount?: number | null;
  reason?: string | null;
  destination?: 'ORIGINAL' | 'WALLET';
  idempotencyKey: string;
  actorUserId: string;
  actorPermissions: readonly string[];
  /** Set only by Admin's maker-checker executor, after a second officer approved (Work 84). */
  makerCheckerApprovalId?: string | null;
}

export interface RefundAdminResult {
  refundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: string;
}

export interface RefundAdminPreview {
  paymentId: string;
  currency: string;
  /** The amount the refund would be: the requested one, or everything still refundable. */
  effectiveAmount: number;
  threshold: number;
  needsSecondApproval: boolean;
}

/**
 * Module 07's manual refund for Admin's maker-checker (Work 84). `refund` is `RefundPaymentCommand`
 * itself (MANUAL initiator), so eligibility, over-refund protection, idempotency, ledger and audit are
 * Module 07's. `preview` answers whether the request needs a second officer, with the same policy
 * the command enforces.
 */
export interface IRefundAdminPort {
  /** `null` when the payment does not exist. */
  preview(paymentId: string, amount?: number | null): Promise<RefundAdminPreview | null>;
  refund(request: RefundAdminRequest): Promise<RefundAdminResult>;
}
