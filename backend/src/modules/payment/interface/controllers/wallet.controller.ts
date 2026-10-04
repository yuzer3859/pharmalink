import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { GetWalletQuery, WalletView } from '../../application/queries/get-wallet.query';
import {
  ListWalletTransactionsQuery,
  WalletTransactionsView,
} from '../../application/queries/list-wallet-transactions.query';
import { ListWalletTransactionsQueryDto } from '../dtos/wallet.dto';

/**
 * Wallet HTTP surface (`architecture/module-07-payment-wallet.md` §9.4).
 *
 * **Read-only, and deliberately so.** §9.4 lists four things; two are here.
 *
 *  - `GET /wallet` and `GET /wallet/transactions` — implemented.
 *  - `POST /wallet/topup` — **not** implemented. Its flow ("`{ amount, method }` → payment flow")
 *    needs a payment this module cannot originate yet: `payments.orderId` is `NOT NULL` and
 *    `AuthorizePaymentCommand` validates the amount against a real Module 06 order, so there is no
 *    order-less payment a top-up could be funded by. `TopUpWalletCommand` exists, is tested, and
 *    credits the wallet the moment such a payment does — but a route whose flow cannot complete is
 *    not an API, and inventing one would couple the wallet directly to a provider, which the
 *    design puts behind the payment module.
 *  - Wallet **spend** — internal by design ("invoked by the checkout saga"). It is exposed to
 *    Module 06 through `IWalletPort` in-process and must never acquire a public route: a customer
 *    who could call it could move their own money outside a checkout.
 *
 * **Identity always comes from the verified access token.** Neither route reads a user id, a
 * wallet id or a ledger account id from a query, path or body — and no DTO here has such a field
 * for a client to supply. Customer isolation is therefore structural rather than a filter that
 * could be forgotten: the account is resolved from `(CUSTOMER_WALLET, token subject, ETB)`, so
 * there is no input by which customer A could name customer B's wallet.
 *
 * Errors are not caught. Every failure is already an `ApiException` and the global
 * `AllExceptionsFilter` maps it.
 */
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly getWallet: GetWalletQuery,
    private readonly listTransactions: ListWalletTransactionsQuery,
  ) {}

  /**
   * §9.4 `GET /wallet` — "balance (from ledger) + summary".
   *
   * The balance is derived on every read as `Σ credits − Σ debits` (F-WAL-01), never served from
   * the `account_balances` cache.
   */
  @Get()
  @RequirePermissions('wallet:read:own')
  get(@CurrentUser() user: AuthenticatedPrincipal): Promise<WalletView> {
    return this.getWallet.execute({ customerUserId: user.userId });
  }

  /**
   * §9.4 `GET /wallet/transactions` — history, newest first.
   *
   * Every movement that ever touched this wallet appears, whatever wrote it: top-ups, checkout
   * spends, and refunds issued with `destination = WALLET`. The wallet keeps no history of its
   * own — it reads the ledger.
   */
  @Get('transactions')
  @RequirePermissions('wallet:read:own')
  list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: ListWalletTransactionsQueryDto,
  ): Promise<WalletTransactionsView> {
    return this.listTransactions.execute({
      customerUserId: user.userId,
      page: query.page,
      size: query.size,
    });
  }
}
