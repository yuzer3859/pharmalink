import { Inject, Injectable } from '@nestjs/common';
import { PayoutRail } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ENCRYPTION_PORT, IEncryptionPort } from '../../../../shared/crypto/crypto.port';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { PaymentErrors } from '../../domain/errors';
import {
  IPayoutRepository,
  PAYOUT_REPOSITORY,
  PayoutBeneficiaryProps,
} from '../../domain/repositories/payout.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { FINANCE_PAYOUT_PERMISSION } from './approve-settlement.command';

/**
 * A changed payout destination may receive money only this long after it is verified (ADR-026's
 * change control, backend/docs/settlement-payout.md). A pharmacy's first destination has none.
 */
export const PAYOUT_BENEFICIARY_COOLING_OFF_HOURS = 24;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RegisterPayoutBeneficiaryInput {
  pharmacyId: string;
  rail: PayoutRail;
  accountName: string;
  bankCode?: string | null;
  accountIdentifier: string;
  actorUserId: string;
  actorPermissions: readonly string[];
}

/** What a reader may see of a beneficiary: never the identifier, only its last four characters. */
export type PayoutBeneficiaryView = Omit<PayoutBeneficiaryProps, 'accountIdentifierEncrypted'>;

export function toBeneficiaryView(b: PayoutBeneficiaryProps): PayoutBeneficiaryView {
  const view: Partial<PayoutBeneficiaryProps> = { ...b };
  delete view.accountIdentifierEncrypted;
  return view as PayoutBeneficiaryView;
}

/**
 * Normalises and validates an account identifier per rail. Bank: 6–34 letters/digits (an account
 * number or IBAN-like form) and a bank code. Telebirr: an Ethiopian mobile number, stored `+2519…`.
 */
export function normaliseAccount(
  rail: PayoutRail,
  identifier: string,
  bankCode: string | null | undefined,
): { identifier: string; bankCode: string | null } {
  const raw = (identifier ?? '').replace(/[\s-]/g, '');
  if (rail === PayoutRail.TELEBIRR) {
    const match = /^(?:\+?251|0)?(9\d{8})$/.exec(raw);
    if (!match) {
      throw PaymentErrors.validation('A Telebirr destination must be an Ethiopian mobile number.', {
        field: 'accountIdentifier',
      });
    }
    return { identifier: `+251${match[1]}`, bankCode: null };
  }
  if (!/^[A-Za-z0-9]{6,34}$/.test(raw)) {
    throw PaymentErrors.validation('A bank account number must be 6 to 34 letters or digits.', {
      field: 'accountIdentifier',
    });
  }
  const code = (bankCode ?? '').trim();
  if (!/^[A-Za-z0-9]{2,20}$/.test(code)) {
    throw PaymentErrors.validation('A bank transfer destination needs a bank code.', { field: 'bankCode' });
  }
  return { identifier: raw.toUpperCase(), bankCode: code.toUpperCase() };
}

/**
 * Registers a pharmacy's payout destination (Work 83, ADR-026). It starts PENDING_VERIFICATION and
 * receives nothing until a *different* finance officer verifies it. The identifier is encrypted
 * before it is written and never logged.
 */
@Injectable()
export class RegisterPayoutBeneficiaryCommand {
  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: IPayoutRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    @Inject(ENCRYPTION_PORT) private readonly crypto: IEncryptionPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RegisterPayoutBeneficiaryInput): Promise<PayoutBeneficiaryView> {
    if (!hasPermission(input.actorPermissions, FINANCE_PAYOUT_PERMISSION)) {
      throw PaymentErrors.payoutPermissionMissing(FINANCE_PAYOUT_PERMISSION);
    }
    if (!UUID.test(input.pharmacyId ?? '')) {
      throw PaymentErrors.validation('pharmacyId must be a UUID.', { field: 'pharmacyId' });
    }
    if (input.rail !== PayoutRail.BANK_TRANSFER && input.rail !== PayoutRail.TELEBIRR) {
      throw PaymentErrors.validation('rail must be BANK_TRANSFER or TELEBIRR.', { field: 'rail' });
    }
    const accountName = (input.accountName ?? '').trim();
    if (accountName.length < 2 || accountName.length > 120) {
      throw PaymentErrors.validation('accountName must be 2 to 120 characters.', { field: 'accountName' });
    }
    const account = normaliseAccount(input.rail, input.accountIdentifier, input.bankCode);

    const created = await this.uow.run(async (tx) => {
      const row = await this.payouts.insertBeneficiary(
        {
          id: randomUUID(),
          pharmacyId: input.pharmacyId,
          rail: input.rail,
          accountName,
          bankCode: account.bankCode,
          accountIdentifierEncrypted: this.crypto.encryptToString(account.identifier),
          accountIdentifierLast4: account.identifier.slice(-4),
          createdByUserId: input.actorUserId,
        },
        tx,
      );
      if (!row) {
        return null;
      }
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PAYOUT_BENEFICIARY_REGISTERED',
          resourceType: 'PayoutBeneficiary',
          resourceId: row.id,
          // Never the identifier: only what the portal shows.
          context: {
            pharmacyId: row.pharmacyId,
            rail: row.rail,
            accountName: row.accountName,
            bankCode: row.bankCode,
            accountIdentifierLast4: row.accountIdentifierLast4,
          },
        },
        tx,
      );
      return row;
    });

    if (!created) {
      const pending = (await this.payouts.findBeneficiaries(input.pharmacyId)).find(
        (b) => b.status === 'PENDING_VERIFICATION',
      );
      throw PaymentErrors.payoutBeneficiaryPending(pending?.id ?? '');
    }
    return toBeneficiaryView(created);
  }
}

export interface VerifyPayoutBeneficiaryInput {
  beneficiaryId: string;
  actorUserId: string;
  actorPermissions: readonly string[];
}

/**
 * Verifies a pending destination (Work 83). The verifier must not be the officer who registered it —
 * enforced here, in the owning module, so no wildcard and no route can skip it. Verifying a
 * replacement supersedes the old destination and starts the cooling-off period.
 */
@Injectable()
export class VerifyPayoutBeneficiaryCommand {
  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: IPayoutRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: VerifyPayoutBeneficiaryInput): Promise<PayoutBeneficiaryView> {
    if (!hasPermission(input.actorPermissions, FINANCE_PAYOUT_PERMISSION)) {
      throw PaymentErrors.payoutPermissionMissing(FINANCE_PAYOUT_PERMISSION);
    }
    const beneficiary = await this.payouts.findBeneficiary(input.beneficiaryId);
    if (!beneficiary) {
      throw PaymentErrors.payoutBeneficiaryNotFound();
    }
    if (beneficiary.createdByUserId === input.actorUserId) {
      throw PaymentErrors.payoutBeneficiarySelfVerification();
    }
    if (beneficiary.status === 'VERIFIED' && beneficiary.verifiedByUserId) {
      return toBeneficiaryView(beneficiary);
    }
    if (beneficiary.status !== 'PENDING_VERIFICATION') {
      throw PaymentErrors.payoutBeneficiaryNotPending(beneficiary.status);
    }

    const verified = await this.uow.run(async (tx) => {
      const now = new Date();
      const replaced = await this.payouts.supersedeVerified(beneficiary.pharmacyId, now, tx);
      const payableFrom = replaced
        ? new Date(now.getTime() + PAYOUT_BENEFICIARY_COOLING_OFF_HOURS * 60 * 60 * 1000)
        : now;
      const row = await this.payouts.verifyBeneficiary(
        beneficiary.id,
        { verifiedByUserId: input.actorUserId, verifiedAt: now, payableFrom },
        tx,
      );
      if (!row) {
        throw PaymentErrors.payoutBeneficiaryNotPending('changed');
      }
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PAYOUT_BENEFICIARY_VERIFIED',
          resourceType: 'PayoutBeneficiary',
          resourceId: row.id,
          context: {
            pharmacyId: row.pharmacyId,
            registeredBy: row.createdByUserId,
            verifiedBy: input.actorUserId,
            replacedPrevious: replaced,
            payableFrom: payableFrom.toISOString(),
            accountIdentifierLast4: row.accountIdentifierLast4,
          },
        },
        tx,
      );
      return row;
    });
    return toBeneficiaryView(verified);
  }
}
