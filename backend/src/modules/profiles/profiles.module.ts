import { Module } from '@nestjs/common';
import { CreateAddressCommand } from './application/commands/create-address.command';
import { DeleteAddressCommand } from './application/commands/delete-address.command';
import { EnsureCustomerProfileCommand } from './application/commands/ensure-customer-profile.command';
import { SetDefaultAddressCommand } from './application/commands/set-default-address.command';
import { UpdateAddressCommand } from './application/commands/update-address.command';
import { UpdateProfileCommand } from './application/commands/update-profile.command';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port';
import { GetAddressQuery } from './application/queries/get-address.query';
import { GetProfileQuery } from './application/queries/get-profile.query';
import { ListAddressesQuery } from './application/queries/list-addresses.query';
import { ADDRESS_REPOSITORY } from './domain/repositories/address.repository';
import { PROFILE_REPOSITORY } from './domain/repositories/profile.repository';
import { PrismaAddressRepository } from './infrastructure/persistence/prisma-address.repository';
import { PrismaProfileRepository } from './infrastructure/persistence/prisma-profile.repository';
import { PrismaUnitOfWork } from './infrastructure/persistence/prisma-unit-of-work';
import { AddressController } from './interface/controllers/address.controller';
import { ProfileController } from './interface/controllers/profile.controller';
import { UserRegisteredHandler } from './interface/events/user-registered.handler';

/**
 * Profiles module composition root (module-02 §10). No new `APP_GUARD`s — `JwtAuthGuard` and
 * `PermissionsGuard` are already global from `IdentityModule` (module-02 §2).
 */
@Module({
  controllers: [ProfileController, AddressController],
  providers: [
    // Repositories
    { provide: PROFILE_REPOSITORY, useClass: PrismaProfileRepository },
    { provide: ADDRESS_REPOSITORY, useClass: PrismaAddressRepository },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },

    // Application use cases
    EnsureCustomerProfileCommand,
    UpdateProfileCommand,
    GetProfileQuery,
    CreateAddressCommand,
    UpdateAddressCommand,
    DeleteAddressCommand,
    SetDefaultAddressCommand,
    ListAddressesQuery,
    GetAddressQuery,

    // Event handlers
    UserRegisteredHandler,
  ],
})
export class ProfilesModule {}
