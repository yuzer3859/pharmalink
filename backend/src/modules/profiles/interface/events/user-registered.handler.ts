import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  IdentityEventType,
  UserRegisteredPayload,
} from '../../../identity/domain/events';
import { EnsureCustomerProfileCommand } from '../../application/commands/ensure-customer-profile.command';

/**
 * Reacts to `identity.user.registered` by lazily upserting an empty `CustomerProfile` row
 * (module-02 §2). `GET /profile/me` also upserts as a safety net for out-of-order delivery, so
 * this handler failing (or running late) never surfaces as a user-visible error.
 */
@Injectable()
export class UserRegisteredHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly ensureCustomerProfile: EnsureCustomerProfileCommand,
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
    await this.ensureCustomerProfile.execute({ userId: event.payload.userId });
  }
}
