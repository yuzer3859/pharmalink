import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPaymentRecipientReadPort,
  PaymentRecipientView,
} from '../../application/ports/inbound/payment-recipient-read.port';

/** `IPaymentRecipientReadPort` over Prisma — a primary-key lookup selecting three columns. */
@Injectable()
export class PrismaPaymentRecipientReadAdapter implements IPaymentRecipientReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async recipientOf(paymentId: string): Promise<PaymentRecipientView | null> {
    const row = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { customerUserId: true, orderId: true, currency: true },
    });
    return row ? { customerUserId: row.customerUserId, orderId: row.orderId, currency: row.currency } : null;
  }
}
