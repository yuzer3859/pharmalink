import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `PATCH /doctor/profile` (Work 166). The name, specialty and licence are set at registration. */
export class UpdateDoctorProfileDto {
  @IsOptional() @IsString() @MaxLength(200) fullNameAm?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @Length(2, 120, { each: true }) subSpecialties?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Length(2, 200, { each: true }) qualifications?: string[];
  @IsOptional() @IsInt() @Min(0) @Max(70) yearsExperience?: number;
  @IsOptional() @IsString() @MaxLength(3000) bio?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @Length(2, 40, { each: true }) languages?: string[];
  /** Consultation fees in santim (1 ETB = 100). */
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) consultationFeeInPerson?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_000) consultationFeeTele?: number;
  @IsOptional() @IsBoolean() acceptsTelemedicine?: boolean;
}

/** `POST /provider/doctors` (Work 166): a facility adds a doctor who practises with it. */
export class AddFacilityDoctorDto {
  /** The doctor's sign-in e-mail or phone. */
  @IsString() @Length(3, 254) identifier!: string;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsString() @MaxLength(120) roleTitle?: string;
}

/** `POST /doctor/availability` (Work 167): a weekly pattern, one-off extra time, or time off. */
export class AvailabilityRuleDto {
  @IsIn(['RECURRING', 'EXCEPTION_AVAILABLE', 'EXCEPTION_BLOCK']) type!: 'RECURRING' | 'EXCEPTION_AVAILABLE' | 'EXCEPTION_BLOCK';
  /** RECURRING: 0 = Sunday … 6 = Saturday. */
  @IsOptional() @IsInt() @Min(0) @Max(6) weekday?: number;
  /** `HH:MM`, Ethiopian local time. */
  @IsOptional() @Matches(TIME) startTime?: string;
  @IsOptional() @Matches(TIME) endTime?: string;
  /** `YYYY-MM-DD`: RECURRING, the first day it applies; an exception, its day. */
  @IsOptional() @Matches(DATE) fromDate?: string;
  /** `YYYY-MM-DD`: RECURRING only, the last day it applies. */
  @IsOptional() @Matches(DATE) toDate?: string;
  @IsOptional() @IsInt() @Min(10) @Max(240) slotDurationMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(120) bufferMinutes?: number;
  @IsIn(['IN_PERSON', 'TELEMEDICINE', 'BOTH']) appointmentType!: 'IN_PERSON' | 'TELEMEDICINE' | 'BOTH';
  /** Where in-person patients are seen: a location of a facility the doctor practises at. */
  @IsOptional() @IsUUID() providerLocationId?: string;
}

/** `GET /doctor/slots`, `GET /doctors/:id/slots` (Work 167): local dates, at most 31 days. */
export class SlotRangeQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}

export class OpenSlotsQueryDto extends SlotRangeQueryDto {
  @IsOptional() @IsIn(['IN_PERSON', 'TELEMEDICINE']) type?: 'IN_PERSON' | 'TELEMEDICINE';
  @IsOptional() @IsUUID() locationId?: string;
}

/** `POST /appointments` (Work 168). */
export class BookAppointmentDto {
  @IsUUID() slotId!: string;
  /** Required when the time is offered both in person and by video. */
  @IsOptional() @IsIn(['IN_PERSON', 'TELEMEDICINE']) appointmentType?: 'IN_PERSON' | 'TELEMEDICINE';
  /** What it is about, for the doctor. */
  @IsOptional() @IsString() @MaxLength(1000) reasonNote?: string;
}

export class RescheduleAppointmentDto {
  @IsUUID() slotId!: string;
}

export class CancelAppointmentDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class DoctorCancelDto {
  @IsString() @Length(3, 500) reason!: string;
}

export class MyAppointmentsQueryDto {
  @IsOptional() @IsIn(['upcoming', 'past']) scope?: 'upcoming' | 'past';
}

export class AppointmentRangeQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsIn(['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW']) status?: string;
}
