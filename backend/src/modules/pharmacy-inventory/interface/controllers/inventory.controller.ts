import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  CATALOG_PICTURE_SUGGESTION_PORT,
  type ICatalogPictureSuggestionPort,
} from '../../../catalog/application/ports/inbound/catalog-picture-suggestion.port';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { AddBatchCommand } from '../../application/commands/add-batch.command';
import { AdjustBatchCommand } from '../../application/commands/adjust-batch.command';
import { CreateListingCommand } from '../../application/commands/create-listing.command';
import { DeleteListingCommand } from '../../application/commands/delete-listing.command';
import { UpdateListingCommand } from '../../application/commands/update-listing.command';
import { GetListingMovementsQuery } from '../../application/queries/get-listing-movements.query';
import { GetListingQuery, ListListingsQuery } from '../../application/queries/list-listings.query';
import { ResolveCallerPharmacyQuery } from '../../application/queries/resolve-caller-pharmacy.query';
import {
  AddBatchDto,
  AdjustBatchDto,
  CreateListingDto,
  GetMovementsQueryDto,
  ListListingsQueryDto,
  RequestPictureUploadDto,
  SuggestPictureDto,
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
    private readonly getListing: GetListingQuery,
    private readonly getListingMovements: GetListingMovementsQuery,
    @Inject(CATALOG_PICTURE_SUGGESTION_PORT) private readonly pictures: ICatalogPictureSuggestionPort,
  ) {}

  /** Work 151: the caller's pharmacy and the product of one of its own listings (else not found). */
  private async stocked(userId: string, listingId: string) {
    const pharmacy = await this.resolveCallerPharmacy.execute(userId);
    const listing = await this.getListing.execute({ pharmacyId: pharmacy.id, listingId });
    return { pharmacyId: pharmacy.id, productId: listing.catalogProductId };
  }

  // ---- Work 151: pictures a pharmacy suggests for a product it stocks ----------------------

  /** The product's pictures as customers see them, and this pharmacy's suggestions for it. */
  @Get('listings/:id/pictures')
  @RequirePermissions('inventory:manage:org')
  async listingPictures(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.pictures.forPharmacy(await this.stocked(user.userId, id));
  }

  @Post('listings/:id/pictures/uploads')
  @RequirePermissions('inventory:manage:org')
  @HttpCode(HttpStatus.CREATED)
  async requestPictureUpload(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string, @Body() dto: RequestPictureUploadDto) {
    return this.pictures.requestUpload({ actorUserId: user.userId, ...(await this.stocked(user.userId, id)), ...dto });
  }

  /** Sends an uploaded picture to catalogue staff; customers see it once they approve it. */
  @Post('listings/:id/pictures/suggestions')
  @RequirePermissions('inventory:manage:org')
  @HttpCode(HttpStatus.CREATED)
  async suggestPicture(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string, @Body() dto: SuggestPictureDto) {
    return this.pictures.suggest({ actorUserId: user.userId, ...(await this.stocked(user.userId, id)), imageUrl: dto.imageUrl });
  }

  @Get('listings')
  @RequirePermissions('inventory:manage:org')
  async list(@CurrentUser() user: AuthenticatedPrincipal, @Query() query: ListListingsQueryDto) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    return this.listListings.execute({ pharmacyId: pharmacy.id, ...query });
  }

  /** Work 111: one listing with its product name and batches; another pharmacy's reads as not found. */
  @Get('listings/:id')
  @RequirePermissions('inventory:manage:org')
  async getOne(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string) {
    const pharmacy = await this.resolveCallerPharmacy.execute(user.userId);
    return this.getListing.execute({ pharmacyId: pharmacy.id, listingId: id });
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
