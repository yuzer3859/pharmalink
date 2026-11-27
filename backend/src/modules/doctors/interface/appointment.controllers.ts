import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../identity/interface/decorators/current-user.decorator';
import { BookingService } from '../application/booking.service';
import { localInstant } from '../domain/slot-generation';
import { AppointmentRangeQueryDto, BookAppointmentDto, CancelAppointmentDto, DoctorCancelDto, MyAppointmentsQueryDto, RescheduleAppointmentDto } from './doctor.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const range = (dto: AppointmentRangeQueryDto) => ({
  from: dto.from ? localInstant(dto.from, '00:00') : undefined,
  to: dto.to ? new Date(localInstant(dto.to, '00:00').getTime() + DAY_MS) : undefined,
});

/**
 * Work 168: a patient books doctors (module-10 §9.2), with `appointment:book:own` (CUSTOMER).
 * The fee is shown and paid at the visit; there is no online payment yet.
 *
 *     POST /appointments                     { slotId, appointmentType?, reasonNote? }, confirmed at once
 *     GET  /appointments?scope=upcoming|past my appointments
 *     GET  /appointments/:id
 *     POST /appointments/:id/cancel          { reason? }, up to 2 hours before
 *     POST /appointments/:id/reschedule      { slotId }, another time with the same doctor, up to 2 hours before
 */
@Controller('appointments')
@RequirePermissions('appointment:book:own')
export class PatientAppointmentsController {
  constructor(private readonly booking: BookingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  book(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: BookAppointmentDto) {
    return this.booking.book(user.userId, dto);
  }

  @Get()
  mine(@CurrentUser() user: AuthenticatedPrincipal, @Query() dto: MyAppointmentsQueryDto) {
    return this.booking.myAppointments(user.userId, dto.scope ?? 'upcoming').then((items) => ({ items }));
  }

  @Get(':appointmentId')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string) {
    return this.booking.patientView(user.userId, appointmentId);
  }

  @Post(':appointmentId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedPrincipal, @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string, @Body() dto: CancelAppointmentDto) {
    return this.booking.cancelByPatient(user.userId, appointmentId, dto.reason);
  }

  @Post(':appointmentId/reschedule')
  @HttpCode(HttpStatus.OK)
  reschedule(@CurrentUser() user: AuthenticatedPrincipal, @Param('appointmentId', new ParseUUIDPipe()) appointmentId: string, @Body() dto: RescheduleAppointmentDto) {
    return this.booking.reschedule(user.userId, appointmentId, dto.slotId);
  }
}

/**
 * Work 168: a doctor's appointments (module-10 §9.3, FR-APPT-10), with `doctor:manage:own`.
 *
 *     GET  /doctor/appointments?from&to&status   from yesterday, 31 days by default, with the patient's contact
 *     POST /doctor/appointments/:id/check-in     from an hour before
 *     POST /doctor/appointments/:id/complete
 *     POST /doctor/appointments/:id/no-show      after the start
 *     POST /doctor/appointments/:id/cancel       { reason }, before the start; the time is not offered again
 */
@Controller('doctor/appointments')
@RequirePermissions('doctor:manage:own')
export class DoctorAppointmentsController {
  constructor(private readonly booking: BookingService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedPrincipal, @Query() dto: AppointmentRangeQueryDto) {
    return this.booking.doctorAppointments(user.userId, { ...range(dto), status: dto.status }).then((items) => ({ items }));
  }

  @Post(':appointmentId/check-in')
  @HttpCode(HttpStatus.OK)
  checkIn(@CurrentUser() user: AuthenticatedPrincipal, @Param('appointmentId', new ParseUUIDPipe()) id: string) {
    return this.booking.doctorAction(user.userId, id, 'check-in');
  }

  @Post(':appointmentId/complete')
  @HttpCode(HttpStatus.OK)
  complete(@CurrentUser() user: AuthenticatedPrincipal, @Param('appointmentId', new ParseUUIDPipe()) id: string) {
    return this.booking.doctorAction(user.userId, id, 'complete');
  }

  @Post(':appointmentId/no-show')
  @HttpCode(HttpStatus.OK)
  noShow(@CurrentUser() user: AuthenticatedPrincipal, @Param('appointmentId', new ParseUUIDPipe()) id: string) {
    return this.booking.doctorAction(user.userId, id, 'no-show');
  }

  @Post(':appointmentId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedPrincipal, @Param('appointmentId', new ParseUUIDPipe()) id: string, @Body() dto: DoctorCancelDto) {
    return this.booking.doctorAction(user.userId, id, 'cancel', dto.reason);
  }
}

/**
 * Work 168: a facility's appointments, those at its locations, with `provider:manage:org`.
 *
 *     GET /provider/appointments?from&to
 */
@Controller('provider/appointments')
@RequirePermissions('provider:manage:org')
export class FacilityAppointmentsController {
  constructor(private readonly booking: BookingService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedPrincipal, @Query() dto: AppointmentRangeQueryDto) {
    return this.booking.facilityAppointments(user.userId, range(dto)).then((items) => ({ items }));
  }
}
