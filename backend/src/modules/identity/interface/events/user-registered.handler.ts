import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
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
 *
 * Work 62: the code goes to the e-mail address when there is one (the channel registration
 * promised). If it can't be delivered, nothing retries it here — the event bus does not, and a
 * retry inside the cooldown would be refused anyway — so the failure is logged without the address
 * and the user asks for a new code with resend once the cooldown has passed.
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
    const identifier = user.email ?? user.phone;
    if (!identifier) {
      return;
    }
    try {
      await this.resendOtp.execute({ identifier, purpose: OtpPurpose.REGISTER });
    } catch (err) {
      // A REGISTER code was already issued within the cooldown (the client asked for one before
      // this event was relayed). That code stands; issuing another is exactly what the cooldown
      // forbids, and retrying the event would not change the answer.
      if (err instanceof ApiException && err.code === ErrorCode.RATE_LIMITED) {
        this.logger.log(`UserRegistered handler: verification code for ${user.id} is within its resend cooldown`);
        return;
      }
      if (err instanceof ApiException && err.code === ErrorCode.DEPENDENCY_UNAVAILABLE) {
        this.logger.warn(`UserRegistered handler: verification code for ${user.id} was not delivered; the user can request a new one`);
        return;
      }
      throw err;
    }
  }
}
