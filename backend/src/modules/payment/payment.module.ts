import { Module } from '@nestjs/common';
import { AuthorizePaymentCommand } from './application/commands/authorize-payment.command';
import { CapturePaymentCommand } from './application/commands/capture-payment.command';
import { ProcessWebhookCommand } from './application/commands/process-webhook.command';
import { ApplyCouponCommand } from './application/commands/apply-coupon.command';
import { ManageCouponCommand } from './application/commands/manage-coupon.command';
import { RefundPaymentCommand } from './application/commands/refund-payment.command';
import { ReverseCouponCommand } from './application/commands/reverse-coupon.command';
import { SpendWalletCommand } from './application/commands/spend-wallet.command';
import { TopUpWalletCommand } from './application/commands/top-up-wallet.command';
import { GetCouponQuery, ListCouponsQuery } from './application/queries/get-coupon.query';
import { GetPaymentQuery } from './application/queries/get-payment.query';
import { ValidateCouponQuery } from './application/queries/validate-coupon.query';
import { GetWalletQuery } from './application/queries/get-wallet.query';
import { ListWalletTransactionsQuery } from './application/queries/list-wallet-transactions.query';
import { ListPaymentRefundsQuery } from './application/queries/list-payment-refunds.query';
import { VoidPaymentCommand } from './application/commands/void-payment.command';
import {
  PaymentAuthorizationPortAdapter,
  PAYMENT_AUTHORIZATION_PORT,
} from './application/ports/inbound/payment-authorization.port';
import { CouponPortAdapter, COUPON_PORT } from './application/ports/inbound/coupon.port';
import {
  FinanceOversightPortAdapter,
  FINANCE_OVERSIGHT_PORT,
} from './application/ports/inbound/finance-oversight.port';
import { RunSettlementCommand } from './application/commands/run-settlement.command';
import {
  GetSettlementQuery,
  ListSettlementsQuery,
} from './application/queries/get-settlement.query';
import { AccountingReconciliationService } from './application/services/accounting-reconciliation.service';
import { ProviderPayableService } from './application/services/provider-payable.service';
import { ProviderScopeService } from './application/services/provider-scope.service';
import { SETTLEMENT_REPOSITORY } from './domain/repositories/settlement.repository';
import { PrismaSettlementRepository } from './infrastructure/persistence/prisma-settlement.repository';
import { WalletPortAdapter, WALLET_PORT } from './application/ports/inbound/wallet.port';
import { CART_PORT } from './application/ports/outbound/cart.port';
import { IDENTITY_PORT } from './application/ports/outbound/identity.port';
import { PHARMACY_PORT } from './application/ports/outbound/pharmacy.port';
import { COUPON_CATALOG_PORT } from './application/ports/outbound/coupon-catalog.port';
import { ORDER_PORT } from './application/ports/outbound/order.port';
import {
  PAYMENT_PROVIDER_PORT,
  PAYMENT_PROVIDER_REGISTRY,
} from './application/ports/outbound/payment-provider.port';
import { PAYMENT_WEBHOOK_REGISTRY } from './application/ports/outbound/payment-webhook.port';
import { UNIT_OF_WORK } from './application/ports/unit-of-work.port';
import { CaptureAccountingService } from './application/services/capture-accounting.service';
import { RefundAccountingService } from './application/services/refund-accounting.service';
import { CouponLineResolver } from './application/services/coupon-line-resolver.service';
import { WalletAccountingService } from './application/services/wallet-accounting.service';
import { ReconciliationService } from './application/services/reconciliation.service';
import { COUPON_REPOSITORY } from './domain/repositories/coupon.repository';
import { LEDGER_REPOSITORY } from './domain/repositories/ledger.repository';
import { PAYMENT_REPOSITORY } from './domain/repositories/payment.repository';
import { REFUND_REPOSITORY } from './domain/repositories/refund.repository';
import { WEBHOOK_REPOSITORY } from './domain/repositories/webhook.repository';
import { LedgerService } from './domain/services/ledger.service';
import { CouponCatalogPortAdapter } from './infrastructure/catalog/coupon-catalog-port.adapter';
import { IdentityPortAdapter } from './infrastructure/identity/identity-port.adapter';
import { PharmacyPortAdapter } from './infrastructure/pharmacy/pharmacy-port.adapter';
import { CartPortAdapter } from './infrastructure/orders/cart-port.adapter';
import { OrderPortAdapter } from './infrastructure/orders/order-port.adapter';
import { PrismaCouponRepository } from './infrastructure/persistence/prisma-coupon.repository';
import { PrismaLedgerRepository } from './infrastructure/persistence/prisma-ledger.repository';
import { PrismaPaymentRepository } from './infrastructure/persistence/prisma-payment.repository';
import { PrismaRefundRepository } from './infrastructure/persistence/prisma-refund.repository';
import { PrismaUnitOfWork } from './infrastructure/persistence/prisma-unit-of-work';
import { PrismaWebhookRepository } from './infrastructure/persistence/prisma-webhook.repository';
import { MockPaymentProvider } from './infrastructure/providers/mock-payment-provider.adapter';
import { PaymentProviderRegistry } from './infrastructure/providers/payment-provider.registry';
import { TelebirrAdapter } from './infrastructure/providers/telebirr/telebirr.adapter';
import { TelebirrConfig } from './infrastructure/providers/telebirr/telebirr.config';
import { TelebirrWebhookAdapter } from './infrastructure/webhooks/telebirr-webhook.adapter';
import { MockWebhookAdapter } from './infrastructure/webhooks/mock-webhook.adapter';
import { WebhookAdapterRegistry } from './infrastructure/webhooks/webhook-adapter.registry';
import { PaymentController } from './interface/controllers/payment.controller';
import { PaymentRefundController } from './interface/controllers/payment-refund.controller';
import { PaymentWebhookController } from './interface/controllers/payment-webhook.controller';
import { AdminCouponController } from './interface/controllers/admin-coupon.controller';
import { AdminReconciliationController } from './interface/controllers/admin-reconciliation.controller';
import { AdminSettlementController } from './interface/controllers/admin-settlement.controller';
import { SettlementController } from './interface/controllers/settlement.controller';
import { CouponController } from './interface/controllers/coupon.controller';
import { WalletController } from './interface/controllers/wallet.controller';

/**
 * Payment, Wallet & Settlement composition root (§10). Wired by the payment-authorization task —
 * the ledger/payment-foundation task deliberately built no Nest module, exactly as Module 06's
 * own foundation task stopped at repositories.
 *
 * No `APP_GUARD`s are added — `JwtAuthGuard`/`PermissionsGuard` are already global from
 * `IdentityModule`, and `AuditService`/`OutboxService`/`PrismaService` come from the `@Global()`
 * `SharedModule` — so none are re-provided here, exactly like every other feature module.
 *
 * Controllers cover §9.1's payment routes and §9.2's provider webhook. No new `APP_GUARD` is
 * registered: `JwtAuthGuard`/`PermissionsGuard` are already global from `IdentityModule`, and the
 * webhook route opts out of bearer auth with `@Public()` because a gateway authenticates by
 * signature instead. The module also still exports `PAYMENT_AUTHORIZATION_PORT` for Module 06 to
 * call in-process, which stays the normal path for the saga-driven operations.
 *
 * `LedgerService` is injected by `CapturePaymentCommand`, which posts §11.3's balanced
 * three-leg capture transaction. Authorization and void make no ledger posting at all.
 *
 * `PAYMENT_PROVIDER_REGISTRY` is the single provider-selection mechanism (§10's Strategy).
 * `TelebirrAdapter`/`TelebirrWebhookAdapter` are registered but report themselves unavailable
 * while the authoritative Telebirr contract is absent from this repository, so routing is
 * unaffected and `MockPaymentProvider` continues to serve development and tests.
 *
 * The refund task added `RefundPaymentCommand`, `RefundAccountingService`, the `refunds` repository
 * and `ListPaymentRefundsQuery`; the refund HTTP task puts §9.3's
 * `POST/GET /payments/{id}/refunds` in front of them as `PaymentRefundController`, which adds no
 * behaviour of its own. `TelebirrAdapter.refund()` refuses exactly as its other operations do, so
 * no refund can be attempted through an unintegrated gateway.
 *
 * The wallet task adds `WalletAccountingService`, `TopUpWalletCommand`, `SpendWalletCommand`,
 * `GetWalletQuery`/`ListWalletTransactionsQuery` and §9.4's two **read** routes, and exports
 * `WALLET_PORT` for Module 06's checkout saga to spend through in-process. It stores no balance
 * anywhere: a wallet is a projection over its owner's `CUSTOMER_WALLET` ledger entries (§5.1,
 * F-WAL-01), which is also why refund-to-wallet needed no wallet code to be reflected — it posts a
 * `CUSTOMER_WALLET` credit (§11.4) and the same derived sum picks it up. §9.4's
 * `POST /wallet/topup` is deliberately absent: no order-less payment exists to fund it (see
 * `TopUpWalletCommand`), and wallet spend is internal by design.
 *
 * The coupon task adds the `Coupon`/`CouponRedemption` aggregates, `CouponValidator`, the
 * `coupons` repository, `ManageCouponCommand`, `ApplyCouponCommand`, `ReverseCouponCommand`,
 * §9.5's customer validation route and its admin CRUD, and exports `COUPON_PORT` for Module 06's
 * checkout and cancellation sagas. Usage is derived from `APPLIED` redemption rows rather than a
 * counter (ADR-006's rule applied outside the ledger), which is also why a reversal needs no
 * compensating write: a `REVERSED` row simply stops being counted. Applying and reversing have no
 * HTTP route by design — both are saga operations, and a customer route that consumed a usage
 * would let them spend their own allowance outside a checkout.
 *
 * The settlement HTTP task puts §9.6's read surface in front of the already-built foundation:
 * `GET /settlements` and `GET /settlements/{id}` (`settlement:read:org`, scoped to the caller's
 * own pharmacies through `ProviderScopeService`) plus the finance surface under
 * `/admin/finance/settlements` — `GET`, `GET /{id}` and `POST /run`, all `finance:settlement:any`
 * and all platform-wide. It adds no accounting: every figure was derived from the immutable
 * ledger when the statement was generated, and the controllers compute nothing. §9.6's
 * `approve|pay` remain absent — `ISettlementRepository` still has no status transition, and a
 * route that marked money paid before anything could pay it is the one mistake an append-only
 * ledger cannot take back.
 *
 * `GET /admin/finance/reconciliation` (`finance:report:any`) exposes
 * `AccountingReconciliationService` unchanged. It reports and never repairs: an automated
 * correction would be a guess about which side of a disagreement is right, written where it could
 * never be withdrawn. Repeated calls are free of consequence, so it is safe to poll.
 *
 * `FINANCE_OVERSIGHT_PORT` (module-16 Work 07) is the read-only seam the control plane consumes:
 * platform-wide payment and refund pages and the stored figures summed by status, projected here
 * so nothing wider than `PaymentView`/`RefundView` (plus the payer and the approver) crosses it.
 * It holds no command. Every mutation — capture, void, refund, settlement run — keeps its own
 * route and permission in this module.
 *
 * Deliberately absent, each belonging to its own later task: the bank/card/cross-border adapters,
 * the real Telebirr protocol, `IProviderStatusPort` lookup adapters, the scheduled reconciliation
 * sweeper, wallet holds (§3.3 F-WAL-03 names them but the design defines no hold model — see
 * `WalletAccountingService`), the Module 06 checkout integration for the wallet, the fraud
 * features, §9.6's GMV/revenue finance report, and the settlement approval/payout half — a route
 * without a command behind it is not an API.
 */
@Module({
  controllers: [
    PaymentController,
    PaymentRefundController,
    PaymentWebhookController,
    WalletController,
    CouponController,
    AdminCouponController,
    SettlementController,
    AdminSettlementController,
    AdminReconciliationController,
  ],
  providers: [
    // Persistence (foundation task)
    { provide: PAYMENT_REPOSITORY, useClass: PrismaPaymentRepository },
    { provide: LEDGER_REPOSITORY, useClass: PrismaLedgerRepository },
    { provide: REFUND_REPOSITORY, useClass: PrismaRefundRepository },
    { provide: COUPON_REPOSITORY, useClass: PrismaCouponRepository },
    // Settlement & reconciliation (F-STL-01/02, F-REC-01). Read-only over the ledger: nothing
    // here posts a transaction, and there is deliberately no payout provider — §11.5's
    // `ExecutePayout` and its SETTLEMENT posting are a separate task.
    { provide: SETTLEMENT_REPOSITORY, useClass: PrismaSettlementRepository },
    ProviderPayableService,
    ProviderScopeService,
    RunSettlementCommand,
    GetSettlementQuery,
    ListSettlementsQuery,
    AccountingReconciliationService,
    { provide: WEBHOOK_REPOSITORY, useClass: PrismaWebhookRepository },
    { provide: UNIT_OF_WORK, useClass: PrismaUnitOfWork },
    LedgerService,

    // Cross-module outbound read ports (own copy per ADR-002). `CART_PORT` and
    // `COUPON_CATALOG_PORT` are the coupon task's: §9.5's validation must be scored against the
    // caller's real cart at real Module 03 prices, never against the request body, and §7's
    // category scope can only be decided from Module 03's own product/category join.
    { provide: ORDER_PORT, useClass: OrderPortAdapter },
    { provide: CART_PORT, useClass: CartPortAdapter },
    { provide: COUPON_CATALOG_PORT, useClass: CouponCatalogPortAdapter },
    // §9.6's settlement reads resolve *which* provider a caller may see from the access token
    // alone: `user_roles.organizationId` (Module 01) -> `pharmacies.organizationId` (Module 04).
    // Two ports because the two id spaces are different and confusing them fails silently.
    { provide: IDENTITY_PORT, useClass: IdentityPortAdapter },
    { provide: PHARMACY_PORT, useClass: PharmacyPortAdapter },

    // Gateways. `PAYMENT_PROVIDER_PORT` is the default/stand-in slot the e2e suites substitute a
    // scripted gateway into; real adapters are registered alongside it and take precedence in the
    // registry. Commands resolve through `PAYMENT_PROVIDER_REGISTRY` and know no provider class.
    { provide: PAYMENT_PROVIDER_PORT, useClass: MockPaymentProvider },
    TelebirrConfig,
    TelebirrAdapter,
    { provide: PAYMENT_PROVIDER_REGISTRY, useClass: PaymentProviderRegistry },

    // The inbound Telebirr half is constructed but deliberately NOT registered in
    // `WebhookAdapterRegistry` while its callback contract is missing — a Telebirr callback is
    // refused as an unintegrated provider rather than accepted and failed on signature.
    TelebirrWebhookAdapter,

    // Inbound callbacks (§9.2). One adapter per gateway, selected by route segment; no
    // PROVIDER_STATUS_REGISTRY is bound yet, so ReconciliationService reports every candidate as
    // not automatically resolvable (see its doc comment).
    MockWebhookAdapter,
    { provide: PAYMENT_WEBHOOK_REGISTRY, useClass: WebhookAdapterRegistry },

    // §11.3 capture accounting, shared by the capture command and the capture webhook, and
    // §11.4 refund accounting, which reverses whatever that capture actually posted.
    CaptureAccountingService,
    RefundAccountingService,
    // §11.6 wallet accounting — the wallet's counterpart to the two above. It owns the
    // CUSTOMER_WALLET account resolution, the derived balance and both wallet postings; no
    // wallet balance is stored anywhere (§5.3, F-WAL-01).
    WalletAccountingService,
    // §9.5's coupon line resolution — turns "this customer's cart" or "this order" into the
    // priced, categorized lines `CouponValidator` scores.
    CouponLineResolver,

    // Authorization (§9.1, §11.1), capture (§11.3) and void (§6)
    AuthorizePaymentCommand,
    CapturePaymentCommand,
    VoidPaymentCommand,

    // Refunds (§3.2, §9.3, §11.4, BRULE-24)
    RefundPaymentCommand,

    // Wallet (§3.3, §11.6). `SpendWalletCommand` has no controller by design — §9.4 makes wallet
    // spend internal to the checkout saga — and `TopUpWalletCommand` has none yet because no
    // order-less payment can fund one (see its doc comment).
    TopUpWalletCommand,
    SpendWalletCommand,

    // Coupons (§3.4, §9.5, F-CPN-01..03). `ApplyCouponCommand`/`ReverseCouponCommand` have no
    // controller by design — a coupon is applied and reversed by the checkout saga in-process
    // through `COUPON_PORT`, and a customer route that consumed a usage would let them spend
    // their own allowance outside a checkout.
    ManageCouponCommand,
    ApplyCouponCommand,
    ReverseCouponCommand,

    // Webhook processing (§9.2, §11.2) and the reconciliation foundation (§3.6 F-REC-01)
    ProcessWebhookCommand,
    ReconciliationService,

    // Reads (§9.1, §9.3, §9.4)
    GetPaymentQuery,
    ListPaymentRefundsQuery,
    GetWalletQuery,
    ListWalletTransactionsQuery,
    ValidateCouponQuery,
    GetCouponQuery,
    ListCouponsQuery,
    { provide: PAYMENT_AUTHORIZATION_PORT, useClass: PaymentAuthorizationPortAdapter },
    { provide: WALLET_PORT, useClass: WalletPortAdapter },
    { provide: COUPON_PORT, useClass: CouponPortAdapter },
    { provide: FINANCE_OVERSIGHT_PORT, useClass: FinanceOversightPortAdapter },
  ],
  exports: [PAYMENT_AUTHORIZATION_PORT, WALLET_PORT, COUPON_PORT, FINANCE_OVERSIGHT_PORT],
})
export class PaymentModule {}
