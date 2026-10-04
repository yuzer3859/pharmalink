import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_WALLET_PAGE_SIZE } from '../../application/queries/list-wallet-transactions.query';

/**
 * `GET /wallet/transactions` (§9.4) — the same `page`/`size` convention as Module 06's
 * `ListOrdersQueryDto` and Module 05's `ListPrescriptionsQueryDto`.
 *
 * This is the wallet's **only** DTO. `GET /wallet` takes nothing at all, and neither route has a
 * body: they are reads. There is no `userId`, no `walletAccountId`, no `accountId` and no
 * `customerUserId` field here or anywhere on the wallet surface — the wallet is resolved from the
 * access token's subject, and `forbidNonWhitelisted` makes sending one a `400` rather than a
 * silently ignored extra.
 *
 * There is no top-up DTO either: §9.4's `POST /wallet/topup` is not exposed by this task (see
 * `TopUpWalletCommand`), and a DTO for a route that does not exist would be speculative.
 */
export class ListWalletTransactionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_WALLET_PAGE_SIZE)
  size?: number = 20;
}
