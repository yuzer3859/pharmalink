import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IOrderRecipientReadPort } from '../../application/ports/inbound/order-recipient-read.port';

/** `IOrderRecipientReadPort` over Prisma — a primary-key lookup selecting one column. */
@Injectable()
export class PrismaOrderRecipientReadAdapter implements IOrderRecipientReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async customerUserIdOf(orderId: string): Promise<string | null> {
    const row = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerUserId: true },
    });
    return row?.customerUserId ?? null;
  }
}
