import { Injectable } from '@nestjs/common';
import {
  SpendWalletCommand,
  SpendWalletInput,
  SpendWalletResult,
} from '../../commands/spend-wallet.command';
import {
  TopUpWalletCommand,
  TopUpWalletInput,
  TopUpWalletResult,
} from '../../commands/top-up-wallet.command';
import { GetWalletQuery, WalletView } from '../../queries/get-wallet.query';

export const WALLET_PORT = Symbol('WALLET_PORT');

/**
 * Module 07's exported wallet contract, consumed in-process by other modules via Nest DI, never
 * over HTTP — the same inbound-port shape as `IPaymentAuthorizationPort` (ADR-002).
 *
 * **This is the seam §11.6's checkout spend will be satisfied through.** Module 06 Slice 1 is
 * COD-only and has no wallet step, and rewriting its checkout saga is explicitly a separate task,
 * so this port is deliberately the smallest thing that task will need rather than a speculative
 * wallet facade. Nothing consumes it yet; `PaymentModule` exports it so the integration task can
 * inject it into `CheckoutCommand` with no new contract work.
 *
 * `spend` is here because §9.4 states plainly that wallet spend is internal and invoked by the
 * checkout saga — it has no HTTP route and must not acquire one. `balance` is here because a
 * checkout saga needs to know whether the wallet can cover a total *before* it commits to that
 * payment method; it is the same derived figure `GET /wallet` serves, never a cached one.
 */
export interface IWalletPort {
  /** §11.6. Atomic against the derived balance; `INSUFFICIENT_WALLET_BALANCE` when it cannot pay. */
  spend(input: SpendWalletInput): Promise<SpendWalletResult>;

  /**
   * Credits a wallet from an already-captured payment (§3.3 F-WAL-02). Exposed on the port because
   * the flow that originates such a payment does not exist in this module yet — see
   * {@link TopUpWalletCommand} — so whichever task builds it will drive this from outside.
   */
  topUp(input: TopUpWalletInput): Promise<TopUpWalletResult>;

  /** `Σ credits − Σ debits` over the customer's wallet entries (§5.3). Read-only. */
  balance(customerUserId: string, currency?: string): Promise<WalletView>;
}

/**
 * Implements `IWalletPort` as a thin facade over the already-tested commands and query — a 1:1,
 * unmodified delegation owning no logic of its own, exactly like `PaymentAuthorizationPortAdapter`.
 * The facade exists only so the exported token is bound to an interface rather than to concrete
 * command classes.
 */
@Injectable()
export class WalletPortAdapter implements IWalletPort {
  constructor(
    private readonly spendWalletCommand: SpendWalletCommand,
    private readonly topUpWalletCommand: TopUpWalletCommand,
    private readonly getWalletQuery: GetWalletQuery,
  ) {}

  spend(input: SpendWalletInput): Promise<SpendWalletResult> {
    return this.spendWalletCommand.execute(input);
  }

  topUp(input: TopUpWalletInput): Promise<TopUpWalletResult> {
    return this.topUpWalletCommand.execute(input);
  }

  balance(customerUserId: string, currency?: string): Promise<WalletView> {
    return this.getWalletQuery.execute({ customerUserId, currency });
  }
}
