import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /admin/accounts/:id/roles`. Exactly what Module 01's own `AssignRoleDto` takes: the role
 * key, and an organization only when the role is ORG-scoped. **No actor, no permission list, no
 * role object** — the actor is the authenticated principal, and a body that names one is
 * rejected by `forbidNonWhitelisted` rather than ignored.
 */
export class AssignRoleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  roleKey!: string;

  @IsUUID()
  @IsOptional()
  organizationId?: string;
}
