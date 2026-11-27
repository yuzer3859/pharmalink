import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ProviderDirectoryModule } from '../provider-directory/provider-directory.module';
import { DOCTOR_ADMIN_PORT } from './application/ports/inbound/doctor-admin.port';
import { DoctorService } from './application/doctor.service';
import { DoctorDiscoveryController, DoctorSelfController, FacilityDoctorsController } from './interface/doctor.controllers';
import { DoctorLicenceHandler } from './interface/doctor-licence.handler';

/**
 * Module 10 — Doctor & Appointment (architecture/module-10-doctor-appointment.md). Work 166
 * builds doctors: profiles registered by a platform administrator on an approved medical
 * licence, the doctor's own profile, the facilities they practise at, public profiles, and the
 * licence-expiry hiding. Availability, slots and booking follow.
 */
@Module({
  imports: [IdentityModule, ProviderDirectoryModule],
  controllers: [DoctorSelfController, FacilityDoctorsController, DoctorDiscoveryController],
  providers: [DoctorService, DoctorLicenceHandler, { provide: DOCTOR_ADMIN_PORT, useExisting: DoctorService }],
  exports: [DOCTOR_ADMIN_PORT],
})
export class DoctorsModule {}
