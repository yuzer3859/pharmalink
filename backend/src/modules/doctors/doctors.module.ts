import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ProviderDirectoryModule } from '../provider-directory/provider-directory.module';
import { DOCTOR_ADMIN_PORT } from './application/ports/inbound/doctor-admin.port';
import { DoctorService } from './application/doctor.service';
import { DoctorDiscoveryController, DoctorSelfController, FacilityDoctorsController } from './interface/doctor.controllers';
import { DoctorLicenceHandler } from './interface/doctor-licence.handler';
import { AvailabilityService } from './application/availability.service';
import { DoctorSearchSourceService } from './application/doctor-search-source.service';
import { DOCTOR_SEARCH_SOURCE_PORT } from './application/ports/inbound/doctor-search-source.port';
import { SlotHorizonJob } from './infrastructure/slot-horizon.job';
import { BookingService } from './application/booking.service';
import { DoctorAppointmentsController, FacilityAppointmentsController, PatientAppointmentsController } from './interface/appointment.controllers';

/**
 * Module 10 — Doctor & Appointment (architecture/module-10-doctor-appointment.md). Work 166
 * builds doctors: profiles registered by a platform administrator on an approved medical
 * licence, the doctor's own profile, the facilities they practise at, public profiles, and the
 * licence-expiry hiding; Work 167 availability rules, bookable slots and the search source.
 * Work 168 booking, cancelling and rescheduling, and the doctor's and facility's appointments.
 */
@Module({
  imports: [IdentityModule, ProviderDirectoryModule],
  controllers: [
    DoctorSelfController,
    FacilityDoctorsController,
    DoctorDiscoveryController,
    PatientAppointmentsController,
    DoctorAppointmentsController,
    FacilityAppointmentsController,
  ],
  providers: [
    DoctorService,
    DoctorLicenceHandler,
    AvailabilityService,
    DoctorSearchSourceService,
    SlotHorizonJob,
    BookingService,
    { provide: DOCTOR_ADMIN_PORT, useExisting: DoctorService },
    { provide: DOCTOR_SEARCH_SOURCE_PORT, useExisting: DoctorSearchSourceService },
  ],
  exports: [DOCTOR_ADMIN_PORT, DOCTOR_SEARCH_SOURCE_PORT, SlotHorizonJob],
})
export class DoctorsModule {}
