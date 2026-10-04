import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { SharedModule } from './shared/shared.module';
import { HealthModule } from './shared/health/health.module';
import { AllExceptionsFilter } from './shared/errors/all-exceptions.filter';
import { ResponseInterceptor } from './shared/errors/response.interceptor';
import { IdentityModule } from './modules/identity/identity.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { PharmacyInventoryModule } from './modules/pharmacy-inventory/pharmacy-inventory.module';
import { PrescriptionMatchingModule } from './modules/prescription-matching/prescription-matching.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentModule } from './modules/payment/payment.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { AdminModule } from './modules/admin/admin.module';

/**
 * Root module. Phase 0 wires the cross-cutting SharedModule + HealthModule and registers the
 * global error filter, success-envelope interceptor, and validation pipe. Feature modules
 * (identity, profiles, notifications, …) are added here as they are implemented, per
 * architecture/00-implementation-roadmap.md.
 */
@Module({
  imports: [
    SharedModule,
    HealthModule,
    IdentityModule,
    ProfilesModule,
    CatalogModule,
    PharmacyInventoryModule,
    PrescriptionMatchingModule,
    OrdersModule,
    PaymentModule,
    DeliveryModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    },
  ],
})
export class AppModule {}
