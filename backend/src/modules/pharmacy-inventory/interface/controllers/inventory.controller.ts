import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { AddBatchCommand } from '../../application/commands/add-batch.command';
import { AdjustBatchCommand } from '../../application/commands/adjust-batch.command';
import { CreateListingCommand } from '../../application/commands/create-listing.command';
import { DeleteListingCommand } from '../../application/commands/delete-listing.command';
import { UpdateListingCommand } from '../../application/commands/update-listing.command';
import { GetListingMovementsQuery } from '../../application/queries/get-listing-movements.query';
import { ListListingsQuery } from '../../application/queries/list-listings.query';
import { ResolveCallerPharmacyQuery } from '../../application/queries/resolve-caller-pharmacy.query';
import {
  AddBatchDto,
  AdjustBatchDto,
  CreateListingDto,
  GetMovementsQueryDto,
  ListListingsQueryDto,
  UpdateListingDto,
} from '../dtos/inventory.dto';

/** Inventory listings/batches/movements (module-04 §10.2). */
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly resolveCallerPharmacy: ResolveCallerPharmacyQuery,
    private readonly createListing: CreateListingCommand,
    private readonly updateListing: UpdateListingCommand,
    private readonly deleteListing: DeleteListingCommand,
    private readonly addBatch: AddBatchCommand,
    private readonly adjustBatch: AdjustBatchCommand,
    private readonly listListings: ListListingsQuery,
    private readonly getListingMovements: GetListingMovementsQuery,
  ) {}

  @Get('listings')
  @RequirePermissions('inventory:manage:org')
  async list(@CurrentUser() user: AuthenticatedPrincipal, @Query() query: ListListingsQueryDto) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    return this.listListings.execute({ pharmacyId: pharmacy.id, ...query });
  }

  @Post('listings')
  @RequirePermissions('inventory:manage:org')
  async create(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateListingDto) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    return this.createListing.execute({ actorUserId: user.userId, pharmacyId: pharmacy.id, ...dto });
  }

  @Patch('listings/:id')
  @RequirePermissions('inventory:manage:org')
  async update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
  ) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    await this.updateListing.execute({
      actorUserId: user.userId,
      pharmacyId: pharmacy.id,
      listingId: id,
      ...dto,
    });
    return { listingId: id };
  }

  @Delete('listings/:id')
  @RequirePermissions('inventory:manage:org')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string): Promise<void> {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    await this.deleteListing.execute({ actorUserId: user.userId, pharmacyId: pharmacy.id, listingId: id });
  }

  @Post('listings/:id/batches')
  @RequirePermissions('inventory:manage:org')
  async addBatchToListing(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: AddBatchDto,
  ) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    return this.addBatch.execute({
      actorUserId: user.userId,
      pharmacyId: pharmacy.id,
      listingId: id,
      ...dto,
    });
  }

  @Patch('batches/:id')
  @RequirePermissions('inventory:manage:org')
  async adjustBatchQuantity(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: AdjustBatchDto,
  ) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    await this.adjustBatch.execute({ actorUserId: user.userId, pharmacyId: pharmacy.id, batchId: id, ...dto });
    return { batchId: id };
  }

  @Get('listings/:id/movements')
  @RequirePermissions('inventory:manage:org')
  async movements(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Query() query: GetMovementsQueryDto,
  ) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    return this.getListingMovements.execute(pharmacy.id, id, query.page, query.size);
  }
}
