import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { ResendOtpCommand } from '../../application/commands/resend-otp.command';
import { OtpPurpose } from '../../domain/enums';
import { IdentityEventType, UserRegisteredPayload } from '../../domain/events';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';

/**
 * Reacts to `identity.user.registered` by issuing + delivering the verification OTP
 * (module-01 §13.1). Kept as an event handler — rather than inline in RegisterUserCommand — so
 * the registration transaction stays fast and other consumers (Module 02, 13) can subscribe to
 * the same event independently.
 */
@Injectable()
export class UserRegisteredHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    private readonly resendOtp: ResendOtpCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(UserRegisteredHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<UserRegisteredPayload>(IdentityEventType.UserRegistered, (event) =>
      this.handle(event),
    );
  }

  private async handle(event: DomainEvent<UserRegisteredPayload>): Promise<void> {
    const user = await this.users.findById(event.payload.userId);
    if (!user) {
      this.logger.warn(`UserRegistered handler: user ${event.payload.userId} not found`);
      return;
    }
    const identifier = user.phone ?? user.email;
    if (!identifier) {
      return;
    }
    await this.resendOtp.execute({ identifier, purpose: OtpPurpose.REGISTER });
  }
}
