import { Body, Controller, Get, Patch } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { UpdateProfileCommand } from '../../application/commands/update-profile.command';
import { GetProfileQuery } from '../../application/queries/get-profile.query';
import { UpdateProfileDto } from '../dtos/profile.dto';

/** Customer profile (module-02 §8.1). All routes require a bearer token (global JwtAuthGuard). */
@Controller('profile')
export class ProfileController {
  constructor(
    private readonly getProfile: GetProfileQuery,
    private readonly updateProfile: UpdateProfileCommand,
  ) {}

  @Get('me')
  @RequirePermissions('profile:read:own')
  me(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.getProfile.execute(user.userId);
  }

  @Patch('me')
  @RequirePermissions('profile:update:own')
  update(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: UpdateProfileDto) {
    return this.updateProfile.execute({ userId: user.userId, ...dto });
  }
}
