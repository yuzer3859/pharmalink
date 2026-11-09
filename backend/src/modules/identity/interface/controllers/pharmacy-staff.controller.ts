import type { Request } from 'express';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { IsIn, IsString, Length } from 'class-validator';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { PHARMACY_STAFF_ROLES, PharmacyStaffService } from '../../application/services/pharmacy-staff.service';
import { CurrentUser } from '../decorators/current-user.decorator';

export class AddPharmacyStaffDto {
  @IsString()
  @Length(3, 254)
  email!: string;

  @IsIn([...PHARMACY_STAFF_ROLES])
  roleKey!: string;
}

/**
 * Work 113: a pharmacy's staff (module-04 §9.2). `staff:manage:org`; the organisation is the
 * caller's own (see `PharmacyStaffService`).
 *
 *   GET    /pharmacy/staff                        members and their roles, and the roles that can be given
 *   POST   /pharmacy/staff        { email, roleKey }  give an existing account a staff role
 *   DELETE /pharmacy/staff/:userId/roles/:roleKey     take a staff role away
 */
@Controller('pharmacy/staff')
export class PharmacyStaffController {
  constructor(private readonly staff: PharmacyStaffService) {}

  @Get()
  @RequirePermissions('staff:manage:org')
  list(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.staff.list(user.userId);
  }

  @Post()
  @RequirePermissions('staff:manage:org')
  add(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: AddPharmacyStaffDto, @Req() req: Request) {
    return this.staff.add({ actorUserId: user.userId, email: dto.email, roleKey: dto.roleKey, ip: req.ip ?? null });
  }

  @Delete(':userId/roles/:roleKey')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('staff:manage:org')
  async remove(@CurrentUser() user: AuthenticatedPrincipal, @Param('userId') userId: string, @Param('roleKey') roleKey: string, @Req() req: Request): Promise<void> {
    await this.staff.remove({ actorUserId: user.userId, userId, roleKey, ip: req.ip ?? null });
  }
}
