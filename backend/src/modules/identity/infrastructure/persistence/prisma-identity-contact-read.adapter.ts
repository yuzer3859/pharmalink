import { Injectable } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { EmailContact, IIdentityContactReadPort, SmsContact } from '../../application/ports/inbound/identity-contact-read.port';
import { Email } from '../../domain/value-objects/email';
import { PhoneNumber } from '../../domain/value-objects/phone-number';

/** Accounts that must not be contacted: the user left (deactivated) or the account is being erased. */
const UNREACHABLE: ReadonlySet<UserStatus> = new Set([UserStatus.DEACTIVATED, UserStatus.DELETED]);

/**
 * `IIdentityContactReadPort` over Prisma — a primary-key lookup of the one identifier asked for,
 * its verification time and the account's status. Each identifier is passed back through Module
 * 01's own value object (`PhoneNumber.normalize`, `Email.normalize`), so a consumer only ever sees
 * the canonical form; a stored value that no longer normalizes is treated as absent.
 */
@Injectable()
export class PrismaIdentityContactReadAdapter implements IIdentityContactReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async smsRecipientOf(userId: string): Promise<SmsContact> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, phoneVerifiedAt: true, status: true, deletedAt: true },
    });
    if (!row) return { available: false, reason: 'UNKNOWN_USER' };
    if (row.deletedAt || UNREACHABLE.has(row.status)) return { available: false, reason: 'INACTIVE' };
    const phone = row.phone ? PhoneNumber.normalize(row.phone) : null;
    if (!phone) return { available: false, reason: 'NO_PHONE' };
    if (!row.phoneVerifiedAt) return { available: false, reason: 'UNVERIFIED' };
    return { available: true, phone };
  }

  async emailRecipientOf(userId: string): Promise<EmailContact> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, status: true, deletedAt: true },
    });
    if (!row) return { available: false, reason: 'UNKNOWN_USER' };
    if (row.deletedAt || UNREACHABLE.has(row.status)) return { available: false, reason: 'INACTIVE' };
    const email = row.email ? Email.normalize(row.email) : null;
    if (!email) return { available: false, reason: 'NO_EMAIL' };
    if (!row.emailVerifiedAt) return { available: false, reason: 'UNVERIFIED' };
    return { available: true, email };
  }
}
