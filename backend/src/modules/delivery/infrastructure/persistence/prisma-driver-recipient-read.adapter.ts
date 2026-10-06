import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IDriverRecipientReadPort } from '../../application/ports/inbound/driver-recipient-read.port';

/** `IDriverRecipientReadPort` over Prisma — a primary-key lookup selecting one column. */
@Injectable()
export class PrismaDriverRecipientReadAdapter implements IDriverRecipientReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async userIdOf(driverProfileId: string): Promise<string | null> {
    const row = await this.prisma.driverProfile.findUnique({
      where: { id: driverProfileId },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }
}
