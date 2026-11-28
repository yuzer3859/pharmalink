import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ProviderDirectoryModule } from '../provider-directory/provider-directory.module';
import { LabBookingService } from './application/lab-booking.service';
import { LabSlotsService } from './application/lab-slots.service';
import { LabResultsService } from './application/lab-results.service';
import { LabDiscoveryController, LabPortalController, PatientLabBookingsController } from './interface/diagnostics.controllers';

/**
 * Module 11 — Diagnostics & Lab Bookings (architecture/module-11-diagnostics-lab.md). Work 172
 * builds at-centre booking: a lab's capacity slots, patients booking one or more tests at a slot
 * with preparation acknowledged, cancelling, and the lab's booking list. The lab's workflow and
 * results, home collection and the apps follow.
 */
@Module({
  imports: [IdentityModule, ProviderDirectoryModule],
  controllers: [LabPortalController, LabDiscoveryController, PatientLabBookingsController],
  providers: [LabSlotsService, LabBookingService, LabResultsService],
  exports: [LabBookingService],
})
export class DiagnosticsModule {}
