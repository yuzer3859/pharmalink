import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { IPaymentAuthorizationPort } from '../../../payment/application/ports/inbound/payment-authorization.port';
import { IOrderRepository } from '../../domain/repositories/order.repository';
import { PrepaidPaymentService } from '../services/prepaid-payment.service';
import { prepaidPaymentKey } from './checkout.command';
import { PayOrderCommand } from './pay-order.command';
import { orderSnapshot } from './test-fixtures';

function build(order = orderSnapshot({ status: 'PENDING_PAYMENT', isCod: false, prescriptionId: 'rx-1', rxReviewStatus: 'APPROVED' })) {
  const orders = { findById: jest.fn().mockResolvedValue(order) } as unknown as jest.Mocked<IOrderRepository>;
  const payments = {
    authorize: jest.fn().mockResolvedValue({ paymentId: 'pay-1', status: 'AUTHORIZED', providerRedirect: null }),
  } as unknown as jest.Mocked<IPaymentAuthorizationPort>;
  const prepaid = { onAuthorized: jest.fn(), onFailed: jest.fn() } as unknown as jest.Mocked<PrepaidPaymentService>;
  return { command: new PayOrderCommand(orders, payments, prepaid), payments, prepaid };
}

const input = { orderId: 'order-1', customerUserId: 'customer-1', payment: { method: 'TELEBIRR' as const, token: 'tok' } };

describe('PayOrderCommand (Work 129: pay once the prescription is approved)', () => {
  it("authorizes with checkout's own key, so a retry never opens a second payment", async () => {
    const { command, payments, prepaid } = build();

    const result = await command.execute(input);

    expect(payments.authorize).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1', method: 'TELEBIRR', idempotencyKey: prepaidPaymentKey('order-1') }));
    expect(prepaid.onAuthorized).toHaveBeenCalledWith({ orderId: 'order-1', paymentId: 'pay-1' });
    expect(result.payment).toEqual({ paymentId: 'pay-1', status: 'AUTHORIZED', providerRedirect: null });
  });

  it('refuses while the prescription is still with the pharmacist', async () => {
    const { command, payments } = build(orderSnapshot({ status: 'PENDING_PAYMENT', isCod: false, rxReviewStatus: 'PENDING' }));
    await expect(command.execute(input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(payments.authorize).not.toHaveBeenCalled();
  });

  it("another customer's order reads as not found, and a COD or paid order is not payable", async () => {
    await expect(build().command.execute({ ...input, customerUserId: 'someone-else' })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    await expect(build(orderSnapshot({ status: 'PAID', isCod: false, rxReviewStatus: 'APPROVED' })).command.execute(input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(build(orderSnapshot({ status: 'PENDING_PAYMENT', isCod: true, rxReviewStatus: 'APPROVED' })).command.execute(input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('a declined payment cancels the order as at checkout, and says which order', async () => {
    const { command, payments, prepaid } = build();
    payments.authorize.mockRejectedValue(new ApiException(ErrorCode.PAYMENT_AUTH_FAILED, 'Declined'));

    await expect(command.execute(input)).rejects.toMatchObject({ code: 'PAYMENT_AUTH_FAILED', details: { orderId: 'order-1' } });
    expect(prepaid.onFailed).toHaveBeenCalledWith({ orderId: 'order-1' });
  });
});
