import { Body, Controller, Get, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { DeactivateAccountCommand } from '../../application/commands/deactivate-account.command';
import { RequestAccountDeletionCommand } from '../../application/commands/request-account-deletion.command';
import { UpdateProfileCommand } from '../../application/commands/update-profile.command';
import { GetCurrentUserQuery } from '../../application/queries/get-current-user.query';
import { CurrentUser } from '../decorators/current-user.decorator';
import {
  ConfirmPasswordDto,
  RequestDeletionDto,
  UpdateProfileDto,
} from '../dtos/profile.dto';

/** Profile & account lifecycle (module-01 §11.5). All routes require a bearer token. */
@Controller('users')
export class UsersController {
  constructor(
    private readonly getCurrentUser: GetCurrentUserQuery,
    private readonly updateProfile: UpdateProfileCommand,
    private readonly deactivateAccount: DeactivateAccountCommand,
    private readonly requestAccountDeletion: RequestAccountDeletionCommand,
  ) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.getCurrentUser.execute(user.userId);
  }

  @Patch('me')
  update(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: UpdateProfileDto) {
    return this.updateProfile.execute({
      userId: user.userId,
      preferredLanguage: dto.preferredLanguage,
    });
  }

  @Post('me/deactivate')
  deactivate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: ConfirmPasswordDto,
    @Req() req: Request,
  ) {
    return this.deactivateAccount.execute({
      userId: user.userId,
      password: dto.password,
      ip: req.ip ?? null,
    });
  }

  @Post('me/delete-request')
  requestDeletion(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: RequestDeletionDto,
    @Req() req: Request,
  ) {
    return this.requestAccountDeletion.execute({
      userId: user.userId,
      password: dto.password,
      reason: dto.reason ?? null,
      ip: req.ip ?? null,
    });
  }
}
