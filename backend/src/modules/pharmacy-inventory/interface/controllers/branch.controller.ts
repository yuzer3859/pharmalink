import { Body, Controller, Get, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { CreateBranchCommand } from '../../application/commands/create-branch.command';
import { SetOperatingHoursCommand } from '../../application/commands/set-operating-hours.command';
import { UpdateBranchCommand } from '../../application/commands/update-branch.command';
import { ResolveCallerPharmacyQuery } from '../../application/queries/resolve-caller-pharmacy.query';
import { BRANCH_REPOSITORY, IBranchRepository } from '../../domain/repositories/branch.repository';
import { CreateBranchDto, SetOperatingHoursDto, UpdateBranchDto } from '../dtos/branch.dto';

/** Branch CRUD + operating hours (module-04 §10.1). */
@Controller('pharmacy/branches')
export class BranchController {
  constructor(
    private readonly resolveCallerPharmacy: ResolveCallerPharmacyQuery,
    private readonly createBranch: CreateBranchCommand,
    private readonly updateBranch: UpdateBranchCommand,
    private readonly setOperatingHours: SetOperatingHoursCommand,
    @Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository,
  ) {}

  @Get()
  @RequirePermissions('pharmacy:manage:org')
  async list(@CurrentUser() user: AuthenticatedPrincipal) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    const rows = await this.branches.findManyByPharmacy(pharmacy.id);
    return rows.map((b) => b.toProps());
  }

  @Post()
  @RequirePermissions('pharmacy:manage:org')
  async create(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateBranchDto) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    return this.createBranch.execute({ pharmacyId: pharmacy.id, ...dto });
  }

  @Patch(':id')
  @RequirePermissions('pharmacy:manage:org')
  async update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    await this.updateBranch.execute({ pharmacyId: pharmacy.id, branchId: id, ...dto });
    return { branchId: id };
  }

  @Put(':id/hours')
  @RequirePermissions('pharmacy:manage:org')
  async hours(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: SetOperatingHoursDto,
  ) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    await this.setOperatingHours.execute({ pharmacyId: pharmacy.id, branchId: id, hours: dto.hours });
    return { branchId: id };
  }
}
