import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IIdentityLanguageReadPort,
  PreferredLanguage,
} from '../../application/ports/inbound/identity-language-read.port';

/** `IIdentityLanguageReadPort` over Prisma — a primary-key lookup selecting one column. */
@Injectable()
export class PrismaIdentityLanguageReadAdapter implements IIdentityLanguageReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async preferredLanguageOf(userId: string): Promise<PreferredLanguage | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { preferredLanguage: true },
    });
    return row ? (row.preferredLanguage as unknown as PreferredLanguage) : null;
  }
}
