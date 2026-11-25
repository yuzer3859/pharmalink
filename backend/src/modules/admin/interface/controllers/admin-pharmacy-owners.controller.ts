import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { PharmacyOwnersService } from '../../application/services/pharmacy-owners.service';

export class ListOwnersQueryDto {
  /** An exact e-mail or phone. */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  identifier?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED', 'DEACTIVATED'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size?: number;
}

export class DisableOwnerDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  /** Also disable every pharmacy they own. */
  @IsBoolean()
  alsoPharmacies!: boolean;
}

export class EnableOwnerDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Also enable every pharmacy they own again (each re-checks its licence). */
  @IsBoolean()
  alsoPharmacies!: boolean;
}

/**
 * Work 157: pharmacy owners for the Super Admin.
 *
 *     GET  /admin/pharmacy-owners                  ?identifier &status &page &size   pharmacy:read:any
 *     GET  /admin/pharmacy-owners/:userId          the owner and every pharmacy they own   pharmacy:read:any
 *     POST /admin/pharmacy-owners/:userId/disable  suspend the account (+ their pharmacies)   user:suspend:any, provider:verify:any
 *     POST /admin/pharmacy-owners/:userId/enable   reinstate the account (+ their pharmacies) user:reactivate:any, provider:verify:any
 */
@Controller('admin/pharmacy-owners')
export class AdminPharmacyOwnersController {
  constructor(private readonly owners: PharmacyOwnersService) {}

  @Get()
  @RequirePermissions('pharmacy:read:any')
  list(@Query() q: ListOwnersQueryDto) {
    return this.owners.list(q).then((r) => ({ ...r, items: r.items.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })) }));
  }

  @Get(':userId')
  @RequirePermissions('pharmacy:read:any')
  async one(@Param('userId', new ParseUUIDPipe()) userId: string) {
    const r = await this.owners.record(userId);
    return { ...r, createdAt: r.createdAt.toISOString() };
  }

  @Post(':userId/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user:suspend:any', 'provider:verify:any')
  disable(@CurrentUser() user: AuthenticatedPrincipal, @Param('userId', new ParseUUIDPipe()) userId: string, @Body() dto: DisableOwnerDto, @Req() req: Request) {
    return this.owners.disable({ actorUserId: user.userId, userId, reason: dto.reason, alsoPharmacies: dto.alsoPharmacies, ip: req.ip ?? null });
  }

  @Post(':userId/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user:reactivate:any', 'provider:verify:any')
  enable(@CurrentUser() user: AuthenticatedPrincipal, @Param('userId', new ParseUUIDPipe()) userId: string, @Body() dto: EnableOwnerDto, @Req() req: Request) {
    return this.owners.enable({ actorUserId: user.userId, userId, reason: dto.reason?.trim() || null, alsoPharmacies: dto.alsoPharmacies, ip: req.ip ?? null });
  }
}
