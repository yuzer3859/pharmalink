import { Module } from '@nestjs/common';
import { PharmacyInventoryModule } from '../pharmacy-inventory/pharmacy-inventory.module';
import { PaymentModule } from '../payment/payment.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { PrescriptionMatchingModule } from '../prescription-matching/prescription-matching.module';
import { AcceptFulfillmentCommand } from './application/commands/accept-fulfillment.command';
import { AddCartItemCommand } from './application/commands/add-cart-item.command';
import { CancelOrderCommand } from './application/commands/cancel-order.command';
import { CheckoutCommand } from './application/commands/checkout.command';
import { ClearCartCommand } from './application/commands/clear-cart.command';
import { QuoteCheckoutCommand } from './application/commands/quote-checkout.command';
import { ValidateCartCommand } from './application/commands/validate-cart.command';
import { DeclineFulfillmentCommand } from './application/commands/decline-fulfillment.command';
import { MarkReadyCommand } from './application/commands/mark-ready.command';
import { PrepareFulfillmentCommand } from './application/commands/prepare-fulfillment.command';
import { RemoveCartItemCommand } from './application/commands/remove-cart-item.command';
import { UpdateCartItemQuantityCommand } from './application/commands/update-cart-item-quantity.command';
import { ADDRESS_PORT } from './application/ports/outbound/address.port';
import { CATALOG_PORT } from './application/ports/outbound/catalog.port';
import { IDENTITY_PORT } from './application/ports/outbound/identity.port';
import { PHARMACY_PORT } from './application/ports/outbound/pharmacy.port';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port';
import { GetActiveCartQuery } from './application/queries/get-active-cart.query';
import { GetOrderInvoiceQuery } from './application/queries/get-order-invoice.query';
import { GetOrderQuery } from './application/queries/get-order.query';
import { ListOrdersQuery } from './application/queries/list-orders.query';
import { ListPharmacyOrdersQuery } from './application/queries/list-pharmacy-orders.query';
import { CART_REPOSITORY } from './domain/repositories/cart.repository';
import { FULFILLMENT_REPOSITORY } from './domain/repositories/fulfillment.repository';
import { ORDER_REPOSITORY } from './domain/repositories/order.repository';
import { AddressPortAdapter } from './infrastructure/address/address-port.adapter';
import { CatalogPortAdapter } from './infrastructure/catalog/catalog-port.adapter';
import { IdentityPortAdapter } from './infrastructure/identity/identity-port.adapter';
import { PharmacyPortAdapter } from './infrastructure/pharmacy/pharmacy-port.adapter';
import { PrismaCartRepository } from './infrastructure/persistence/prisma-cart.repository';
import { PrismaFulfillmentRepository } from './infrastructure/persistence/prisma-fulfillment.repository';
import { PrismaOrderRepository } from './infrastructure/persistence/prisma-order.repository';
import { ORDER_ANALYTICS_READ_PORT } from './application/ports/inbound/order-analytics-read.port';
import { ORDER_RECIPIENT_READ_PORT } from './application/ports/inbound/order-recipient-read.port';
import { PrismaOrderAnalyticsReadAdapter } from './infrastructure/persistence/prisma-order-analytics-read.adapter';
import { PrismaOrderRecipientReadAdapter } from './infrastructure/persistence/prisma-order-recipient-read.adapter';
import { PrismaUnitOfWork } from './infrastructure/persistence/prisma-unit-of-work';
import { CartController } from './interface/controllers/cart.controller';
import { CheckoutController } from './interface/controllers/checkout.controller';
import { OrdersController } from './interface/controllers/orders.controller';
import { PharmacyOrdersController } from './interface/controllers/pharmacy-orders.controller';

/**
 * Cart, Checkout & Orders composition root (`06-orders-spec.md` §11, §14 step 8). No new
 * `APP_GUARD`s — `JwtAuthGuard`/`PermissionsGuard` are already global from `IdentityModule`;
 * `AuditService`/`OutboxService`/`CONFIG_PORT` come from the `@Global()` `SharedModule`, so none
 * are re-provided here, exactly like every other feature module.
 *
 * Imports `PrescriptionMatchingModule` for the three inbound ports it exports and this module's
 * commands inject directly (`CHECK_RX_GATE_PORT` for the checkout Rx gate, and `MATCHING_PORT` for checkout
 * matching), and `PharmacyInventoryModule` for `INVENTORY_PORT` (reservation release on cancel and
 * on checkout compensation). Both are direct in-process DI dependencies, never HTTP calls
 * (ADR-002 / module-05 §10.4).
 *
 * Routes registered here cover §9.1 (cart), §9.2 (checkout), §9.3 (orders) and §9.4 (pharmacy
 * fulfillment). §9.4's org scoping runs through `IPharmacyPort`, which resolves a
 * `Fulfillment.pharmacyId` (a `Pharmacy.id`) to its owning `Organization.id` — the id space
 * `user_roles.organizationId` and therefore `IIdentityPort` actually speak in.
 *
 * Deliberately absent:
 *  - `POST /cart/validate` and `POST /checkout/quote` (§9.1/§9.2) — no command exists for either,
 *    and `/cart/validate` additionally depends on `PRICE_CHANGED`, which §10 defers.
 *  - every `/admin/orders/*` route (§0.2, out of Slice 1).
 */
@Module({
  // `PaymentModule` exports `COUPON_PORT` (ADR-002's inbound-port shape). It imports nothing from
  // here — its own `IOrderPort` adapter reads `orders` through Prisma — so there is no cycle.
  imports: [PrescriptionMatchingModule, PharmacyInventoryModule, PaymentModule, DeliveryModule],
  controllers: [CartController, CheckoutController, OrdersController, PharmacyOrdersController],
  providers: [
    // Repositories
    { provide: CART_REPOSITORY, useClass: PrismaCartRepository },
    { provide: ORDER_REPOSITORY, useClass: PrismaOrderRepository },
    // Inbound read contract for Module 16's operational dashboard (module-16 Work 08): order and
    // fulfillment counts by status, aggregated in PostgreSQL.
    { provide: ORDER_ANALYTICS_READ_PORT, useClass: PrismaOrderAnalyticsReadAdapter },
    // Inbound read contract for Module 13's order lifecycle notifications (module-13 Work 02): an
    // order's `customerUserId`, nothing else. These two ports are the only things this module
    // exports.
    { provide: ORDER_RECIPIENT_READ_PORT, useClass: PrismaOrderRecipientReadAdapter },
    { provide: FULFILLMENT_REPOSITORY, useClass: PrismaFulfillmentRepository },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },

    // Cross-module outbound ports (own copies per ADR-002)
    { provide: CATALOG_PORT, useClass: CatalogPortAdapter },
    { provide: ADDRESS_PORT, useClass: AddressPortAdapter },
    { provide: IDENTITY_PORT, useClass: IdentityPortAdapter },
    { provide: PHARMACY_PORT, useClass: PharmacyPortAdapter },

    // Cart (§9.1)
    GetActiveCartQuery,
    AddCartItemCommand,
    UpdateCartItemQuantityCommand,
    RemoveCartItemCommand,
    ClearCartCommand,
    ValidateCartCommand,
    QuoteCheckoutCommand,

    // Checkout saga (§9.2)
    CheckoutCommand,

    // Orders (§9.3)
    ListOrdersQuery,
    GetOrderQuery,
    GetOrderInvoiceQuery,
    CancelOrderCommand,

    // Pharmacy fulfillment (§9.4)
    ListPharmacyOrdersQuery,
    AcceptFulfillmentCommand,
    DeclineFulfillmentCommand,
    PrepareFulfillmentCommand,
    MarkReadyCommand,
  ],
  exports: [ORDER_ANALYTICS_READ_PORT, ORDER_RECIPIENT_READ_PORT],
})
export class OrdersModule {}
