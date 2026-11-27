import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../shared/events/event-bus.service';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { IdentityEventType } from '../../identity/domain/events';
import { DoctorService } from '../application/doctor.service';

/**
 * Work 166 (BRULE-06/08): when Module 01 expires a doctor's medical licence (and suspends the
 * account), the doctor leaves the directory and can no longer be booked. Idempotent; a failure is
 * logged, never thrown into the bus.
 */
@Injectable()
export class DoctorLicenceHandler implements OnModuleInit {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly doctors: DoctorService,
  ) {
    this.logger.setContext(DoctorLicenceHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<Record<string, unknown>>(IdentityEventType.LicenseExpired, (event: DomainEvent<Record<string, unknown>>) => this.onExpired(event));
  }

  private async onExpired(event: DomainEvent<Record<string, unknown>>): Promise<void> {
    const payload = event?.payload ?? {};
    if (payload.verificationType !== 'DOCTOR_LICENSE' || typeof payload.userId !== 'string') return;
    try {
      await this.doctors.licenceExpired(payload.userId);
    } catch (err) {
      this.logger.error({ message: 'Suspending a doctor with an expired licence failed', eventId: event?.id ?? null, error: err instanceof Error ? err.message : String(err) });
    }
  }
}
