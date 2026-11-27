import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Public } from '../../../shared/rbac/public.decorator';
import { RequirePermissions } from '../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../identity/interface/decorators/current-user.decorator';
import { AvailabilityService } from '../application/availability.service';
import { DoctorService } from '../application/doctor.service';
import { AddFacilityDoctorDto, AvailabilityRuleDto, OpenSlotsQueryDto, SlotRangeQueryDto, UpdateDoctorProfileDto } from './doctor.dto';

/**
 * Work 166: a doctor runs their own professional profile (module-10 §9.3), with
 * `doctor:manage:own` (role DOCTOR).
 *
 *     GET   /doctor/profile   my profile, where I practise, and my status
 *     PATCH /doctor/profile   Amharic name, sub-specialties, qualifications, experience, bio, languages, fees, telemedicine
 *
 * Work 167, my availability and calendar:
 *
 *     GET    /doctor/availability           my rules
 *     POST   /doctor/availability           a weekly pattern, extra time, or time off; slots are regenerated
 *     DELETE /doctor/availability/:ruleId
 *     GET    /doctor/slots?from&to          my calendar (every status)
 *     POST   /doctor/slots/:id/block        an open slot, ad hoc; /unblock opens it again
 */
@Controller('doctor')
@RequirePermissions('doctor:manage:own')
export class DoctorSelfController {
  constructor(
    private readonly doctors: DoctorService,
    private readonly availability: AvailabilityService,
  ) {}

  @Get('availability')
  rules(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.availability.rules(user.userId).then((items) => ({ items }));
  }

  @Post('availability')
  @HttpCode(HttpStatus.CREATED)
  addRule(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: AvailabilityRuleDto) {
    return this.availability.addRule(user.userId, dto);
  }

  @Delete('availability/:ruleId')
  removeRule(@CurrentUser() user: AuthenticatedPrincipal, @Param('ruleId', new ParseUUIDPipe()) ruleId: string) {
    return this.availability.removeRule(user.userId, ruleId);
  }

  @Get('slots')
  slots(@CurrentUser() user: AuthenticatedPrincipal, @Query() dto: SlotRangeQueryDto) {
    return this.availability.ownSlots(user.userId, dto.from, dto.to).then((items) => ({ items }));
  }

  @Post('slots/:slotId/block')
  @HttpCode(HttpStatus.OK)
  block(@CurrentUser() user: AuthenticatedPrincipal, @Param('slotId', new ParseUUIDPipe()) slotId: string) {
    return this.availability.setSlotBlocked(user.userId, slotId, true);
  }

  @Post('slots/:slotId/unblock')
  @HttpCode(HttpStatus.OK)
  unblock(@CurrentUser() user: AuthenticatedPrincipal, @Param('slotId', new ParseUUIDPipe()) slotId: string) {
    return this.availability.setSlotBlocked(user.userId, slotId, false);
  }

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
 *     GET /doctors/:id/slots           Work 167: open slots (`from`, `to` local dates, at most 31 days; `type`; `locationId`)
 */
@Public()
@Controller()
export class DoctorDiscoveryController {
  constructor(
    private readonly doctors: DoctorService,
    private readonly availability: AvailabilityService,
  ) {}

  @Get('doctors/:doctorId/slots')
  slots(@Param('doctorId', new ParseUUIDPipe()) doctorId: string, @Query() dto: OpenSlotsQueryDto) {
    return this.availability.openSlots(doctorId, dto).then((items) => ({ items }));
  }

  @Get('doctors/:doctorId')
  doctor(@Param('doctorId', new ParseUUIDPipe()) doctorId: string) {
    return this.doctors.publicProfile(doctorId);
  }

  @Get('providers/:providerId/doctors')
  providerDoctors(@Param('providerId', new ParseUUIDPipe()) providerId: string) {
    return this.doctors.providerDoctors(providerId).then((items) => ({ items }));
  }
}
