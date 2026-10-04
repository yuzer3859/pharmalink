import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { CreateAddressCommand } from '../../application/commands/create-address.command';
import { DeleteAddressCommand } from '../../application/commands/delete-address.command';
import { SetDefaultAddressCommand } from '../../application/commands/set-default-address.command';
import { UpdateAddressCommand } from '../../application/commands/update-address.command';
import { GetAddressQuery } from '../../application/queries/get-address.query';
import { ListAddressesQuery } from '../../application/queries/list-addresses.query';
import { CreateAddressDto, UpdateAddressDto } from '../dtos/address.dto';

/** Delivery address book (module-02 §8.2). All routes require a bearer token. */
@Controller('addresses')
export class AddressController {
  constructor(
    private readonly listAddresses: ListAddressesQuery,
    private readonly getAddress: GetAddressQuery,
    private readonly createAddress: CreateAddressCommand,
    private readonly updateAddress: UpdateAddressCommand,
    private readonly deleteAddress: DeleteAddressCommand,
    private readonly setDefaultAddress: SetDefaultAddressCommand,
  ) {}

  @Get()
  @RequirePermissions('address:read:own')
  list(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.listAddresses.execute(user.userId);
  }

  @Get(':id')
  @RequirePermissions('address:read:own')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.getAddress.execute(user.userId, id);
  }

  @Post()
  @RequirePermissions('address:manage:own')
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateAddressDto) {
    return this.createAddress.execute({ userId: user.userId, ...dto });
  }

  @Patch(':id')
  @RequirePermissions('address:manage:own')
  update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.updateAddress.execute({ userId: user.userId, addressId: id, ...dto });
  }

  @Delete(':id')
  @RequirePermissions('address:manage:own')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string): Promise<void> {
    await this.deleteAddress.execute({ userId: user.userId, addressId: id });
  }

  @Post(':id/default')
  @RequirePermissions('address:manage:own')
  setDefault(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.setDefaultAddress.execute({ userId: user.userId, addressId: id });
  }
}
