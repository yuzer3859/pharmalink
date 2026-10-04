import { ArrayUnique, IsArray, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class SetRolePermissionsDto {
  /** Complete desired permission set for the role (replace semantics). */
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions!: string[];
}

export class SuspendUserDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}

export class AssignRoleDto {
  @IsString()
  roleKey!: string;

  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
