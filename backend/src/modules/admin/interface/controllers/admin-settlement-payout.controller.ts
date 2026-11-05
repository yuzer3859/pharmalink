import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import {
  FINANCE_PAYOUT_PERMISSION,
  FINANCE_SETTLEMENT_PERMISSION,
} from '../../../payment/application/commands/approve-settlement.command';
import {
  ISettlementPayoutPort,
  SETTLEMENT_PAYOUT_PORT,
} from '../../../payment/application/ports/inbound/settlement-payout.port';
import { RequireIdempotencyKey } from '../../../payment/interface/decorators/idempotency-key.decorator';
import { toApprovalView } from '../../application/maker-checker/approval-queries';
import {
  MakerCheckerGate,
  SubmitSensitiveActionResult,
} from '../../application/maker-checker/maker-checker-gate.service';
import { GetPharmacyOperationsQuery } from '../../application/queries/pharmacy-operations.queries';
import { AdminErrors } from '../../domain/errors';
import {
  PAYOUT_BENEFICIARY_VERIFY_ACTION,
  SETTLEMENT_APPROVE_ACTION,
  SETTLEMENT_PAYOUT_ACTION,
} from '../../infrastructure/maker-checker/settlement-payout.actions';
import { MakerCheckerReasonDto, RegisterPayoutBeneficiaryDto } from '../dtos/settlement-payout.dto';
import { toApprovalResponse } from '../dtos/approval.response';

/**
 * Settlement approval, payout and payout destinations (Work 83; module-07 §15.11, module-16 §11.2).
 *
 * Approve, pay and verify go through `MakerCheckerGate`: by default each is recorded as a pending
 * request (`202`, `outcome: MAKER_CHECKER_PENDING`) for a different finance officer to decide on the
 * Approvals page; with the action switched off in `approvals.makerCheckerActions` it runs at once
 * (`200`, `outcome: EXECUTED`). Registering a destination and refreshing an open payout move no
 * money and run directly. All of it is Module 07's command behind `SETTLEMENT_PAYOUT_PORT`.
 */
@Controller('admin/finance')
export class AdminSettlementPayoutController {
  constructor(
    private readonly gate: MakerCheckerGate,
    private readonly pharmacies: GetPharmacyOperationsQuery,
    @Inject(SETTLEMENT_PAYOUT_PORT) private readonly payouts: ISettlementPayoutPort,
  ) {}

  @Get('settlements/:id/payout')
  @RequirePermissions(FINANCE_SETTLEMENT_PERMISSION)
  async payout(@Param('id', new ParseUUIDPipe()) id: string) {
    const view = await this.payouts.payoutView(id);
    if (!view) throw AdminErrors.settlementNotFound();
    return view;
  }

  @Post('settlements/:id/approve')
  @RequirePermissions(FINANCE_SETTLEMENT_PERMISSION)
  async approve(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MakerCheckerReasonDto,
    @RequireIdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const view = await this.requireSettlement(id);
    return this.answer(
      await this.gate.submit({
        actionType: SETTLEMENT_APPROVE_ACTION,
        payload: { settlementId: id, netPayable: view.settlement.netPayable, currency: view.settlement.currency, pharmacyId: view.settlement.pharmacyId },
        makerUserId: user.userId,
        makerPermissions: user.permissions ?? [],
        idempotencyKey,
        reason: body.reason ?? null,
        ip: req.ip ?? null,
      }),
      user,
      res,
    );
  }

  @Post('settlements/:id/pay')
  @RequirePermissions(FINANCE_PAYOUT_PERMISSION)
  async pay(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MakerCheckerReasonDto,
    @RequireIdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const view = await this.requireSettlement(id);
    return this.answer(
      await this.gate.submit({
        actionType: SETTLEMENT_PAYOUT_ACTION,
        payload: { settlementId: id, netPayable: view.settlement.netPayable, currency: view.settlement.currency, pharmacyId: view.settlement.pharmacyId },
        makerUserId: user.userId,
        makerPermissions: user.permissions ?? [],
        idempotencyKey,
        reason: body.reason ?? null,
        ip: req.ip ?? null,
      }),
      user,
      res,
    );
  }

  @Post('settlements/:id/payout/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(FINANCE_PAYOUT_PERMISSION)
  refresh(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payouts.refresh(id, { actorUserId: user.userId, actorPermissions: user.permissions ?? [] });
  }

  @Get('pharmacies/:pharmacyId/payout-beneficiaries')
  @RequirePermissions(FINANCE_SETTLEMENT_PERMISSION)
  async beneficiaries(@Param('pharmacyId', new ParseUUIDPipe()) pharmacyId: string) {
    return { items: await this.payouts.listBeneficiaries(pharmacyId) };
  }

  @Post('pharmacies/:pharmacyId/payout-beneficiaries')
  @RequirePermissions(FINANCE_PAYOUT_PERMISSION)
  async register(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('pharmacyId', new ParseUUIDPipe()) pharmacyId: string,
    @Body() body: RegisterPayoutBeneficiaryDto,
  ) {
    await this.pharmacies.execute(pharmacyId); // 404 for an unknown pharmacy
    return this.payouts.registerBeneficiary(
      {
        pharmacyId,
        rail: body.rail,
        accountName: body.accountName,
        bankCode: body.bankCode ?? null,
        accountIdentifier: body.accountIdentifier,
      },
      { actorUserId: user.userId, actorPermissions: user.permissions ?? [] },
    );
  }

  @Post('payout-beneficiaries/:id/verify')
  @RequirePermissions(FINANCE_PAYOUT_PERMISSION)
  async verify(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MakerCheckerReasonDto,
    @RequireIdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const beneficiary = await this.payouts.findBeneficiary(id);
    if (!beneficiary) throw AdminErrors.payoutBeneficiaryNotFound();
    return this.answer(
      await this.gate.submit({
        actionType: PAYOUT_BENEFICIARY_VERIFY_ACTION,
        payload: {
          beneficiaryId: id,
          pharmacyId: beneficiary.pharmacyId,
          accountName: beneficiary.accountName,
          rail: beneficiary.rail,
          accountIdentifierLast4: beneficiary.accountIdentifierLast4,
        },
        makerUserId: user.userId,
        makerPermissions: user.permissions ?? [],
        idempotencyKey,
        reason: body.reason ?? null,
        ip: req.ip ?? null,
      }),
      user,
      res,
    );
  }

  private async requireSettlement(id: string) {
    const view = await this.payouts.payoutView(id);
    if (!view) throw AdminErrors.settlementNotFound();
    return view;
  }

  private answer(result: SubmitSensitiveActionResult, user: AuthenticatedPrincipal, res: Response) {
    if (result.outcome === 'EXECUTED') {
      res.status(HttpStatus.OK);
      return { outcome: 'EXECUTED', result: result.result };
    }
    res.status(HttpStatus.ACCEPTED);
    return {
      outcome: 'MAKER_CHECKER_PENDING',
      approval: toApprovalResponse(
        toApprovalView(result.approval, { userId: user.userId, permissions: user.permissions ?? [] }, new Date()),
      ),
    };
  }
}
