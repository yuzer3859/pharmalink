import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CatalogPictureSuggestionService } from '../../application/services/catalog-picture-suggestion.service';
import { ListPictureSuggestionsQueryDto, RejectPictureSuggestionDto } from '../dtos/picture-suggestion.dto';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ChangeProductStatusCommand } from '../../application/commands/change-product-status.command';
import { CreateCategoryCommand } from '../../application/commands/create-category.command';
import { CreateManufacturerCommand } from '../../application/commands/create-manufacturer.command';
import { CreateProductCommand } from '../../application/commands/create-product.command';
import { DisableCategoryCommand } from '../../application/commands/disable-category.command';
import { UpdateCategoryCommand } from '../../application/commands/update-category.command';
import { UpdateManufacturerCommand } from '../../application/commands/update-manufacturer.command';
import { UpdateProductCommand } from '../../application/commands/update-product.command';
import { GetProductQuery } from '../../application/queries/get-product.query';
import { ListCategoriesAdminQuery } from '../../application/queries/list-categories-admin.query';
import { ListManufacturersQuery } from '../../application/queries/list-manufacturers.query';
import { CreateCategoryDto, UpdateCategoryDto } from '../dtos/category.dto';
import { CreateManufacturerDto, UpdateManufacturerDto } from '../dtos/manufacturer.dto';
import { ChangeProductStatusDto, CreateProductDto, RequestImageUploadDto, UpdateProductDto } from '../dtos/product.dto';
import { CatalogImageService } from '../../application/services/catalog-image.service';

/**
 * Admin Catalog curation (module-03 §7.2/§8.2), all behind `catalog:manage:any`. No
 * ownership/scope check beyond the permission itself — there is no non-admin writer in Slice 1
 * (§7.2).
 */
@Controller('admin/catalog')
@RequirePermissions('catalog:manage:any')
export class AdminCatalogController {
  constructor(
    private readonly createProduct: CreateProductCommand,
    private readonly updateProduct: UpdateProductCommand,
    private readonly changeProductStatus: ChangeProductStatusCommand,
    private readonly getProduct: GetProductQuery,
    private readonly createCategory: CreateCategoryCommand,
    private readonly updateCategory: UpdateCategoryCommand,
    private readonly disableCategory: DisableCategoryCommand,
    private readonly listCategoriesAdmin: ListCategoriesAdminQuery,
    private readonly createManufacturer: CreateManufacturerCommand,
    private readonly updateManufacturer: UpdateManufacturerCommand,
    private readonly listManufacturers: ListManufacturersQuery,
    private readonly catalogImages: CatalogImageService,
    private readonly pictureSuggestions: CatalogPictureSuggestionService,
  ) {}

  // ---- Products ----------------------------------------------------------------------------

  @Get('products/:id')
  getOne(@Param('id') id: string) {
    return this.getProduct.execute(id, true);
  }

  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateProductDto) {
    return this.createProduct.execute({ actorUserId: user.userId, ...dto });
  }

  @Patch('products/:id')
  update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.updateProduct.execute({ actorUserId: user.userId, productId: id, ...dto });
  }

  /** Work 150: a signed upload link for one product picture; save its `imageUrl` in `images` after. */
  @Post('products/:id/images/uploads')
  @HttpCode(HttpStatus.CREATED)
  requestImageUpload(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: RequestImageUploadDto,
  ) {
    return this.catalogImages.requestUpload({ actorUserId: user.userId, productId: id, ...dto });
  }

  // ---- Work 151: pictures suggested by pharmacies ------------------------------------------

  @Get('picture-suggestions')
  listPictureSuggestions(@Query() query: ListPictureSuggestionsQueryDto) {
    return this.pictureSuggestions.listForReview(query);
  }

  /** Adds the picture to the product (last); customers see it at once. */
  @Post('picture-suggestions/:id/approve')
  @HttpCode(HttpStatus.OK)
  approvePictureSuggestion(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.pictureSuggestions.approve({ actorUserId: user.userId, suggestionId: id });
  }

  @Post('picture-suggestions/:id/reject')
  @HttpCode(HttpStatus.OK)
  rejectPictureSuggestion(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectPictureSuggestionDto,
  ) {
    return this.pictureSuggestions.reject({ actorUserId: user.userId, suggestionId: id, reason: dto.reason });
  }

  @Post('products/:id/status')
  @HttpCode(HttpStatus.OK)
  changeStatus(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: ChangeProductStatusDto,
  ) {
    return this.changeProductStatus.execute({ actorUserId: user.userId, productId: id, ...dto });
  }

  // ---- Categories ---------------------------------------------------------------------------

  @Get('categories')
  listCategories() {
    return this.listCategoriesAdmin.execute();
  }

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  createCategoryRoute(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateCategoryDto) {
    return this.createCategory.execute({ actorUserId: user.userId, ...dto });
  }

  @Patch('categories/:id')
  updateCategoryRoute(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.updateCategory.execute({ actorUserId: user.userId, categoryId: id, ...dto });
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disableCategoryRoute(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.disableCategory.execute({ actorUserId: user.userId, categoryId: id });
  }

  // ---- Manufacturers ------------------------------------------------------------------------

  @Get('manufacturers')
  listManufacturersRoute() {
    return this.listManufacturers.execute();
  }

  @Post('manufacturers')
  @HttpCode(HttpStatus.CREATED)
  createManufacturerRoute(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: CreateManufacturerDto,
  ) {
    return this.createManufacturer.execute({ actorUserId: user.userId, ...dto });
  }

  @Patch('manufacturers/:id')
  updateManufacturerRoute(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateManufacturerDto,
  ) {
    return this.updateManufacturer.execute({ actorUserId: user.userId, manufacturerId: id, ...dto });
  }
}
