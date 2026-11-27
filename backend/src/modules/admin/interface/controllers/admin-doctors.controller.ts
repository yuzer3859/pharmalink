import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { ALLOWED_DOCUMENT_CONTENT_TYPES } from '../../../../shared/storage/document-storage.port';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { DOCTOR_STATUSES } from '../../../doctors/domain/doctor-rules';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { DoctorRegistrationService } from '../../application/services/doctor-registration.service';

export const DOCTOR_DOCUMENT_KINDS = ['MEDICAL_LICENSE', 'DEGREE_CERTIFICATE', 'SPECIALTY_CERTIFICATE', 'NATIONAL_ID', 'OTHER'] as const;

export class RequestDoctorDocumentUploadDto {
  @IsUUID() userId!: string;
  @IsIn([...ALLOWED_DOCUMENT_CONTENT_TYPES]) contentType!: string;
  @IsInt() @Min(1) @Max(10 * 1024 * 1024) bytes!: number;
}

export class DoctorDocumentDto {
  @IsIn([...DOCTOR_DOCUMENT_KINDS]) kind!: string;
  @IsString() @MaxLength(512) @Matches(/^doc:/, { message: 'storageRef must be an uploaded file.' }) storageRef!: string;
}

export class RegisterDoctorDto {
  @IsUUID() userId!: string;
  /** The name patients see, e.g. "Dr. Selamawit Bekele". */
  @IsString() @Length(3, 160) fullName!: string;
  @IsOptional() @IsString() @MaxLength(160) fullNameAm?: string;
  @IsString() @Length(2, 120) specialty!: string;
  @IsString() @Length(1, 64) licenseNumber!: string;
  /** `YYYY-MM-DD`, the medical licence's last valid day. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/) licenseExpiresOn!: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => DoctorDocumentDto) documents!: DoctorDocumentDto[];
}

export class ListDoctorsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() @MaxLength(120) specialty?: string;
  @IsOptional() @IsIn([...DOCTOR_STATUSES]) status?: (typeof DOCTOR_STATUSES)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) size?: number = 20;
}

export class SuspendDoctorDto {
  @IsString() @Length(3, 500) reason!: string;
}

/**
 * Work 166: the Super Admin registers doctors (Module 10).
 *
 *     POST /admin/doctor-registrations/uploads   a signed upload for one licence or certificate, stored under the person
 *     POST /admin/doctor-registrations           account becomes a doctor, licence approved, profile created and listed
 *
 * `provider:verify:any` (approves the licence). The person signs up in the PharmaLink app first.
 */
@Controller('admin/doctor-registrations')
@RequirePermissions('provider:verify:any')
export class AdminDoctorRegistrationController {
  constructor(private readonly registrations: DoctorRegistrationService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  upload(@Body() dto: RequestDoctorDocumentUploadDto, @Req() req: Request) {
    return this.registrations.requestUpload({ userId: dto.userId, contentType: dto.contentType, bytes: dto.bytes, ip: req.ip ?? null });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  register(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: RegisterDoctorDto, @Req() req: Request) {
    return this.registrations.register({ actorUserId: user.userId, ...dto, ip: req.ip ?? null });
  }
}

/**
 * Work 166: the Super Admin's doctor records.
 *
 *     GET  /admin/doctors                 by name, specialty or licence number, and status
 *     GET  /admin/doctors/:id             the record: profile, licence, account, where they practise
 *     POST /admin/doctors/:id/suspend     { reason } — hidden and signed out at once
 *     POST /admin/doctors/:id/reactivate  again, while the licence is current
 */
@Controller('admin/doctors')
export class AdminDoctorsController {
  constructor(private readonly registrations: DoctorRegistrationService) {}

  @Get()
  @RequirePermissions('doctor:read:any')
  list(@Query() dto: ListDoctorsQueryDto) {
    const page = dto.page ?? 1;
    const size = dto.size ?? 20;
    return this.registrations.list({ q: dto.q, specialty: dto.specialty, status: dto.status }, page, size).then((r) => ({ ...r, page, size }));
  }

  @Get(':doctorId')
  @RequirePermissions('doctor:read:any')
  get(@Param('doctorId', new ParseUUIDPipe()) doctorId: string) {
    return this.registrations.get(doctorId);
  }

  @Post(':doctorId/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('provider:verify:any', 'user:suspend:any')
  suspend(@CurrentUser() user: AuthenticatedPrincipal, @Param('doctorId', new ParseUUIDPipe()) doctorId: string, @Body() dto: SuspendDoctorDto, @Req() req: Request) {
    return this.registrations.suspend({ actorUserId: user.userId, doctorId, reason: dto.reason, ip: req.ip ?? null });
  }

  @Post(':doctorId/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('provider:verify:any', 'user:reactivate:any')
  reactivate(@CurrentUser() user: AuthenticatedPrincipal, @Param('doctorId', new ParseUUIDPipe()) doctorId: string, @Req() req: Request) {
    return this.registrations.reactivate({ actorUserId: user.userId, doctorId, ip: req.ip ?? null });
  }
}
