import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { PROVIDER_ADMIN_READ_PORT } from './application/ports/inbound/provider-admin-read.port';
import { PROVIDER_ONBOARDING_PORT } from './application/ports/inbound/provider-onboarding.port';
import { ProviderAdminReadService } from './application/provider-admin-read.service';
import { ProviderOnboardingService } from './application/provider-onboarding.service';
import { ProviderLicenceExpirySweeper } from './infrastructure/provider-licence-expiry.sweeper';
import { ProviderPortalService } from './application/provider-portal.service';
import { ProviderPortalController } from './interface/provider-portal.controller';
import { ProviderDiscoveryController } from './interface/provider-discovery.controller';
import { PROVIDER_SEARCH_SOURCE_PORT } from './application/ports/inbound/provider-search-source.port';
import { ProviderSearchSourceService } from './application/provider-search-source.service';

/**
 * Module 09 — Provider Directory (architecture/module-09-provider-directory.md): hospitals,
 * clinics, diagnostic centres and labs. Work 160 builds registration, activation on an approved
 * facility licence, manual suspension and licence-expiry suspension, and the administrator's read;
 * Work 161 the facility's own profile, locations, hours, facilities, departments and services;
 * Work 162 public discovery and the search source Module 14 indexes.
 */
@Module({
  imports: [IdentityModule],
  controllers: [ProviderPortalController, ProviderDiscoveryController],
  providers: [
    ProviderPortalService,
    ProviderSearchSourceService,
    { provide: PROVIDER_SEARCH_SOURCE_PORT, useExisting: ProviderSearchSourceService },
    ProviderOnboardingService,
    ProviderAdminReadService,
    ProviderLicenceExpirySweeper,
    { provide: PROVIDER_ONBOARDING_PORT, useExisting: ProviderOnboardingService },
    { provide: PROVIDER_ADMIN_READ_PORT, useExisting: ProviderAdminReadService },
  ],
  exports: [PROVIDER_ONBOARDING_PORT, PROVIDER_ADMIN_READ_PORT, PROVIDER_SEARCH_SOURCE_PORT, ProviderLicenceExpirySweeper],
})
export class ProviderDirectoryModule {}
