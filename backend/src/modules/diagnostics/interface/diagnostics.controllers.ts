import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Public } from '../../../shared/rbac/public.decorator';
import { RequirePermissions } from '../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../identity/interface/decorators/current-user.decorator';
import { localInstant } from '../../doctors/domain/slot-generation';
import { LabBookingService } from '../application/lab-booking.service';
import { LabSlotsService } from '../application/lab-slots.service';

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export class CreateLabSlotsDto {
  @IsUUID() locationId!: string;
  @Matches(DATE) fromDate!: string;
  @Matches(DATE) toDate!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) weekdays!: number[];
  @Matches(TIME) startTime!: string;
  @Matches(TIME) endTime!: string;
  @Type(() => Number) @IsInt() @Min(5) @Max(240) intervalMinutes!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) capacity!: number;
}

export class DateRangeDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsUUID() locationId?: string;
}

export class LabBookingsQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsIn(['CONFIRMED', 'CHECKED_IN', 'SAMPLE_COLLECTED', 'PROCESSING', 'RESULT_READY', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'SAMPLE_REJECTED']) status?: string;
}

export class BookLabDto {
  @IsUUID() providerId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ArrayUnique() @IsUUID('all', { each: true }) serviceIds!: string[];
  @IsUUID() slotId!: string;
  @IsOptional() @IsBoolean() prepAcknowledged?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class MyLabBookingsQueryDto {
  @IsOptional() @IsIn(['upcoming', 'past']) scope?: 'upcoming' | 'past';
}

export class CancelLabBookingDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

const range = (dto: { from?: string; to?: string }) => ({
  from: dto.from ? localInstant(dto.from, '00:00') : undefined,
  to: dto.to ? new Date(localInstant(dto.to, '00:00').getTime() + DAY_MS) : undefined,
});

/**
 * Work 172: a lab's capacity slots and bookings (module-11 §8.2), with `provider:manage:org`.
 * Only laboratories and diagnostic centres.
 *
 *     POST   /provider/diagnostics/slots              { locationId, fromDate, toDate, weekdays, startTime, endTime, intervalMinutes, capacity }
 *     GET    /provider/diagnostics/slots?from&to&locationId
 *     POST   /provider/diagnostics/slots/:id/block    /unblock
 *     DELETE /provider/diagnostics/slots/:id          an empty future time
 *     GET    /provider/diagnostics/bookings?from&to&status
 */
@Controller('provider/diagnostics')
@RequirePermissions('provider:manage:org')
export class LabPortalController {
  constructor(
    private readonly slots: LabSlotsService,
    private readonly bookings: LabBookingService,
  ) {}

  @Post('slots')
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateLabSlotsDto) {
    return this.slots.createSlots(user.userId, dto);
  }

  @Get('slots')
  list(@CurrentUser() user: AuthenticatedPrincipal, @Query() dto: DateRangeDto) {
    return this.slots.labSlots(user.userId, { ...range(dto), locationId: dto.locationId }).then((items) => ({ items }));
  }

  @Post('slots/:slotId/block')
  @HttpCode(HttpStatus.OK)
  block(@CurrentUser() user: AuthenticatedPrincipal, @Param('slotId', new ParseUUIDPipe()) slotId: string) {
    return this.slots.setBlocked(user.userId, slotId, true);
  }

  @Post('slots/:slotId/unblock')
  @HttpCode(HttpStatus.OK)
  unblock(@CurrentUser() user: AuthenticatedPrincipal, @Param('slotId', new ParseUUIDPipe()) slotId: string) {
    return this.slots.setBlocked(user.userId, slotId, false);
  }

  @Delete('slots/:slotId')
  remove(@CurrentUser() user: AuthenticatedPrincipal, @Param('slotId', new ParseUUIDPipe()) slotId: string) {
    return this.slots.remove(user.userId, slotId);
  }

  @Get('bookings')
  bookingsList(@CurrentUser() user: AuthenticatedPrincipal, @Query() dto: LabBookingsQueryDto) {
    return this.bookings.labBookings(user.userId, { ...range(dto), status: dto.status }).then((items) => ({ items }));
  }
}

/**
 * Work 172: a lab's open times, for patients (module-11 §8.1), no sign-in.
 *
 *     GET /diagnostics/providers/:providerId/slots?from&to&locationId
 */
@Public()
@Controller('diagnostics/providers')
export class LabDiscoveryController {
  constructor(private readonly slots: LabSlotsService) {}

  @Get(':providerId/slots')
  open(@Param('providerId', new ParseUUIDPipe()) providerId: string, @Query() dto: DateRangeDto) {
    return this.slots.openSlots(providerId, { ...range(dto), locationId: dto.locationId }).then((items) => ({ items }));
  }
}

/**
 * Work 172: a patient books lab tests at a centre (module-11 §8.1), with `diagnostics:book:own`.
 * Confirmed at once; paid at the centre.
 *
 *     POST /diagnostics/bookings               { providerId, serviceIds, slotId, prepAcknowledged?, notes? }
 *     GET  /diagnostics/bookings?scope=upcoming|past
 *     GET  /diagnostics/bookings/:id
 *     POST /diagnostics/bookings/:id/cancel    { reason? }, up to 2 hours before
 */
@Controller('diagnostics/bookings')
@RequirePermissions('diagnostics:book:own')
export class PatientLabBookingsController {
  constructor(private readonly bookings: LabBookingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  book(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: BookLabDto) {
    return this.bookings.book(user.userId, dto);
  }

  @Get()
  mine(@CurrentUser() user: AuthenticatedPrincipal, @Query() dto: MyLabBookingsQueryDto) {
    return this.bookings.myBookings(user.userId, dto.scope ?? 'upcoming').then((items) => ({ items }));
  }

  @Get(':bookingId')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('bookingId', new ParseUUIDPipe()) bookingId: string) {
    return this.bookings.patientView(user.userId, bookingId);
  }

  @Post(':bookingId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedPrincipal, @Param('bookingId', new ParseUUIDPipe()) bookingId: string, @Body() dto: CancelLabBookingDto) {
    return this.bookings.cancelByPatient(user.userId, bookingId, dto.reason);
  }
}
