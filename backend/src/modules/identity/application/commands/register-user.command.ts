import { Inject, Injectable } from '@nestjs/common';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { AccountStatus, PreferredLanguage, PrimaryRole } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { userRegisteredEvent } from '../../domain/events';
import { Email } from '../../domain/value-objects/email';
import { PhoneNumber } from '../../domain/value-objects/phone-number';
import { PasswordPolicy } from '../../domain/value-objects/password-policy';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import {
  IRoleAssignmentRepository,
  ROLE_ASSIGNMENT_REPOSITORY,
} from '../../domain/repositories/role-assignment.repository';
import { HASHER, IHasher } from '../ports/hasher.port';
import { INotificationPort, NOTIFICATION_PORT } from '../ports/notification.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';

export interface RegisterUserInput {
  phone?: string;
  email?: string;
  password: string;
  preferredLanguage?: 'am' | 'en';
}

export interface RegisterUserOutput {
  userId: string;
  status: AccountStatus;
  verification: { channel: 'SMS' | 'EMAIL'; target: string };
}

/**
 * Registration use case (module-01 §3.1, §11.1, §13.1). This slice supports self-registration
 * as CUSTOMER only — provider/staff onboarding (invited/verified) is a later slice.
 *
 * Verification channel (Work 62): e-mail whenever an address is given, even with a phone number,
 * because e-mail is the channel that can deliver today. The channel must be deliverable before
 * any account is created, so a registration never leaves a pending account whose code can't
 * arrive: phone-only is refused while SMS has no provider, and e-mail is refused while Resend is
 * not configured. When SMS is approved, `INotificationPort.canDeliver('SMS')` turns phone-only on.
 */
@Injectable()
export class RegisterUserCommand {
  private readonly passwordPolicy = new PasswordPolicy();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(HASHER) private readonly hasher: IHasher,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    @Inject(ROLE_ASSIGNMENT_REPOSITORY) private readonly roleAssignments: IRoleAssignmentRepository,
    private readonly outbox: OutboxService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: INotificationPort,
  ) {}

  async execute(input: RegisterUserInput): Promise<RegisterUserOutput> {
    if (!input.phone && !input.email) {
      throw IdentityErrors.validation('Provide a phone number or an email address.', {
        fields: ['phone', 'email'],
      });
    }

    const phone = input.phone ? PhoneNumber.create(input.phone) : null;
    const email = input.email ? Email.create(input.email) : null;
    this.passwordPolicy.assert(input.password);

    const channel: 'SMS' | 'EMAIL' = email ? 'EMAIL' : 'SMS';
    if (!this.notifications.canDeliver(channel)) {
      throw channel === 'SMS'
        ? IdentityErrors.emailRequiredForRegistration()
        : IdentityErrors.deliveryUnavailable('EMAIL', 'NOT_CONFIGURED');
    }

    if (phone && (await this.users.findByPhone(phone.value))) {
      throw IdentityErrors.duplicateIdentifier({ field: 'phone' });
    }
    if (email && (await this.users.findByEmail(email.value))) {
      throw IdentityErrors.duplicateIdentifier({ field: 'email' });
    }

    const passwordHash = await this.hasher.hash(input.password);
    const preferredLanguage =
      input.preferredLanguage === 'am' ? PreferredLanguage.am : PreferredLanguage.en;

    const user = await this.uow.run(async (tx) => {
      const created = await this.users.create(
        {
          phone: phone?.value ?? null,
          email: email?.value ?? null,
          passwordHash,
          primaryRole: PrimaryRole.CUSTOMER,
          status: AccountStatus.PENDING_VERIFICATION,
          preferredLanguage,
        },
        tx,
      );

      await this.roleAssignments.assignByRoleKey(created.id, created.primaryRole, null, tx);

      await this.outbox.write(
        userRegisteredEvent({
          userId: created.id,
          role: created.primaryRole,
          locale: created.preferredLanguage,
        }),
        tx as never,
      );

      return created;
    });

    const target = email ? email.masked() : (phone as PhoneNumber).masked();

    return { userId: user.id, status: user.status, verification: { channel, target } };
  }
}
