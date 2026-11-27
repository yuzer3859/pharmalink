import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { AvailabilityService } from '../application/availability.service';

/**
 * Work 167 (F-AVL-04): every night, each active doctor's slots are extended to the full booking
 * horizon and past unbooked slots are removed.
 */
@Injectable()
export class SlotHorizonJob {
  private readonly logger = new AppLogger();

  constructor(private readonly availability: AvailabilityService) {
    this.logger.setContext(SlotHorizonJob.name);
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async run(): Promise<number> {
    const doctors = await this.availability.regenerateAll();
    this.logger.log(`Extended the booking horizon for ${doctors} doctors.`);
    return doctors;
  }
}
