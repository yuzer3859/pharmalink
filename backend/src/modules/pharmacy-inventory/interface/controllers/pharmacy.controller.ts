import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ActivatePharmacyCommand } from '../../application/commands/activate-pharmacy.command';
import { RegisterPharmacyCommand } from '../../application/commands/register-pharmacy.command';
import { UpdatePharmacyProfileCommand } from '../../application/commands/update-pharmacy-profile.command';
import { ResolveCallerPharmacyQuery } from '../../application/queries/resolve-caller-pharmacy.query';
import { ActivatePharmacyDto, RegisterPharmacyDto, SuspendPharmacyDto, UpdatePharmacyProfileDto } from '../dtos/pharmacy.dto';
import { SuspendPharmacyCommand } from '../../application/commands/suspend-pharmacy.command';

/** Pharmacy onboarding & profile (module-04 §10.1). */
@Controller('pharmacy')
export class PharmacyController {
  constructor(
    private readonly registerPharmacy: RegisterPharmacyCommand,
    private readonly activatePharmacy: ActivatePharmacyCommand,
    private readonly updateProfile: UpdatePharmacyProfileCommand,
    private readonly resolveCallerPharmacy: ResolveCallerPharmacyQuery,
    private readonly suspendPharmacy: SuspendPharmacyCommand,
  ) {}

  @Post('register')
  @RequirePermissions('pharmacy:register')
  register(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: RegisterPharmacyDto) {
    return this.registerPharmacy.execute({ actorUserId: user.userId, ...dto });
  }

  @Get('profile')
  @RequirePermissions('pharmacy:manage:org')
  async profile(@CurrentUser() user: AuthenticatedPrincipal) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    return pharmacy.toProps();
  }

  @Patch('profile')
  @RequirePermissions('pharmacy:manage:org')
  async updateOwnProfile(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: UpdatePharmacyProfileDto,
  ) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    await this.updateProfile.execute({ pharmacyId: pharmacy.id, ...dto });
    return { pharmacyId: pharmacy.id };
  }

  @Post('activate')
  @RequirePermissions('provider:verify:any')
  async activate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: ActivatePharmacyDto,
  ) {
    await this.activatePharmacy.execute({ actorUserId: user.userId, pharmacyId: body.pharmacyId });
    return { pharmacyId: body.pharmacyId, transactingStatus: 'ACTIVE' };
  }

  /** Work 153: stop a pharmacy trading; `activate` enables it again after re-checking its licence. */
  @Post('suspend')
  @RequirePermissions('provider:verify:any')
  async suspend(@CurrentUser() user: AuthenticatedPrincipal, @Body() body: SuspendPharmacyDto) {
    const { suspended } = await this.suspendPharmacy.execute({ actorUserId: user.userId, pharmacyId: body.pharmacyId, reason: body.reason });
    return { pharmacyId: body.pharmacyId, transactingStatus: 'SUSPENDED', changed: suspended };
  }
}
