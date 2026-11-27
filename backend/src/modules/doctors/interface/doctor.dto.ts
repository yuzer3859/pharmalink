import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';

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
