import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Public } from '../../../shared/rbac/public.decorator';
import { RequirePermissions } from '../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../identity/interface/decorators/current-user.decorator';
import { DoctorService } from '../application/doctor.service';
import { AddFacilityDoctorDto, UpdateDoctorProfileDto } from './doctor.dto';

/**
 * Work 166: a doctor runs their own professional profile (module-10 §9.3), with
 * `doctor:manage:own` (role DOCTOR).
 *
 *     GET   /doctor/profile   my profile, where I practise, and my status
 *     PATCH /doctor/profile   Amharic name, sub-specialties, qualifications, experience, bio, languages, fees, telemedicine
 */
@Controller('doctor')
@RequirePermissions('doctor:manage:own')
export class DoctorSelfController {
  constructor(private readonly doctors: DoctorService) {}

  @Get('profile')
  profile(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.doctors.ownProfile(user.userId);
  }

  @Patch('profile')
  update(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: UpdateDoctorProfileDto) {
    return this.doctors.updateOwnProfile(user.userId, dto);
  }
}

/**
 * Work 166: a facility names the doctors who practise with it (module-09 F-DEP-02, FR-HOSP-08),
 * with `provider:manage:org`. The doctor must already be registered by PharmaLink.
 *
 *     GET    /provider/doctors             my facility's doctors
 *     POST   /provider/doctors             { identifier, departmentId?, roleTitle? }
 *     DELETE /provider/doctors/:doctorId   no longer practises here
 */
@Controller('provider/doctors')
@RequirePermissions('provider:manage:org')
export class FacilityDoctorsController {
  constructor(private readonly doctors: DoctorService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.doctors.facilityDoctors(user.userId).then((items) => ({ items }));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  add(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: AddFacilityDoctorDto) {
    return this.doctors.addFacilityDoctor(user.userId, dto);
  }

  @Delete(':doctorId')
  remove(@CurrentUser() user: AuthenticatedPrincipal, @Param('doctorId', new ParseUUIDPipe()) doctorId: string) {
    return this.doctors.removeFacilityDoctor(user.userId, doctorId);
  }
}

/**
 * Work 166: public doctor discovery (module-10 §9.1), no sign-in. Only listed doctors (active,
 * verified, current licence) are shown; searching doctors and their slots comes in Work 167.
 *
 *     GET /doctors/:id                 a doctor's profile and where they practise
 *     GET /providers/:id/doctors       a facility's doctors
 */
@Public()
@Controller()
export class DoctorDiscoveryController {
  constructor(private readonly doctors: DoctorService) {}

  @Get('doctors/:doctorId')
  doctor(@Param('doctorId', new ParseUUIDPipe()) doctorId: string) {
    return this.doctors.publicProfile(doctorId);
  }

  @Get('providers/:providerId/doctors')
  providerDoctors(@Param('providerId', new ParseUUIDPipe()) providerId: string) {
    return this.doctors.providerDoctors(providerId).then((items) => ({ items }));
  }
}
