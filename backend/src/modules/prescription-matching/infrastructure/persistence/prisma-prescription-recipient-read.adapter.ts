import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IPrescriptionRecipientReadPort } from '../../application/ports/inbound/prescription-recipient-read.port';

/** `IPrescriptionRecipientReadPort` over Prisma — primary-key lookups selecting one column each. */
@Injectable()
export class PrismaPrescriptionRecipientReadAdapter implements IPrescriptionRecipientReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async customerUserIdOfPrescription(prescriptionId: string): Promise<string | null> {
    const row = await this.prisma.prescription.findUnique({
      where: { id: prescriptionId },
      select: { customerUserId: true },
    });
    return row?.customerUserId ?? null;
  }

  async customerUserIdOfMatchRequest(matchRequestId: string): Promise<string | null> {
    const row = await this.prisma.matchRequest.findUnique({
      where: { id: matchRequestId },
      select: { customerUserId: true },
    });
    return row?.customerUserId ?? null;
  }
}
