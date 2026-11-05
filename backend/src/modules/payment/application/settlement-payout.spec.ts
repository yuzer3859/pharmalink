import { PayoutRail } from '@prisma/client';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { ApiException } from '../../../shared/errors/api-exception';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { AdminSettlementPayoutController } from '../../admin/interface/controllers/admin-settlement-payout.controller';
import { MockPayoutProvider } from '../infrastructure/providers/payout/mock-payout-provider.adapter';
import { UnavailablePayoutProvider } from '../infrastructure/providers/payout/unavailable-payout-provider.adapter';
import { normaliseAccount, toBeneficiaryView } from './commands/payout-beneficiary.commands';
import { payoutAttemptReference, settlementLedgerReference } from './commands/execute-payout.command';
import { IPayoutProviderPort, PayoutOutcome, PayoutRequest } from './ports/outbound/payout-provider.port';

const request = (accountIdentifier: string, reference = 'PAYOUT-a1'): PayoutRequest => ({
  reference,
  settlementId: 's1',
  pharmacyId: 'p1',
  amount: 10_000,
  currency: 'ETB',
  beneficiary: { rail: PayoutRail.BANK_TRANSFER, accountName: 'Seed', bankCode: 'CBE', accountIdentifier },
});

describe('Settlement payout (Work 83)', () => {
  describe('normaliseAccount', () => {
    it('stores Telebirr numbers as +2519XXXXXXXX and accepts the local forms', () => {
      for (const raw of ['0911223344', '911223344', '+251911223344', '251 911-223-344']) {
        expect(normaliseAccount(PayoutRail.TELEBIRR, raw, null)).toEqual({ identifier: '+251911223344', bankCode: null });
      }
      for (const raw of ['0811223344', '091122334', 'abc']) {
        expect(() => normaliseAccount(PayoutRail.TELEBIRR, raw, null)).toThrow(ApiException);
      }
    });

    it('requires a bank code and a 6–34 character account for a bank transfer', () => {
      expect(normaliseAccount(PayoutRail.BANK_TRANSFER, '1000 1234-5678', 'cbe')).toEqual({
        identifier: '100012345678',
        bankCode: 'CBE',
      });
      expect(() => normaliseAccount(PayoutRail.BANK_TRANSFER, '100012345678', null)).toThrow(ApiException);
      expect(() => normaliseAccount(PayoutRail.BANK_TRANSFER, '12345', 'CBE')).toThrow(ApiException);
    });

    it('never exposes the encrypted identifier in a view', () => {
      const view = toBeneficiaryView({
        id: 'b1',
        pharmacyId: 'p1',
        rail: PayoutRail.TELEBIRR,
        accountName: 'Seed',
        bankCode: null,
        accountIdentifierEncrypted: 'secret-ciphertext',
        accountIdentifierLast4: '3344',
        status: 'VERIFIED',
        createdByUserId: 'u1',
        verifiedByUserId: 'u2',
        verifiedAt: new Date(),
        payableFrom: new Date(),
        supersededAt: null,
        createdAt: new Date(),
      });
      expect(view).not.toHaveProperty('accountIdentifierEncrypted');
      expect(JSON.stringify(view)).not.toContain('secret-ciphertext');
    });
  });

  describe('references (ADR-024)', () => {
    it('keys the ledger posting on the settlement and the provider call on the attempt', () => {
      expect(settlementLedgerReference('s1')).toBe('SETTLEMENT-s1');
      expect(payoutAttemptReference('a1')).toBe('PAYOUT-a1');
    });
  });

  describe('MockPayoutProvider', () => {
    it('pays, and answers a repeat of the same reference ALREADY_PAID', async () => {
      const rail = new MockPayoutProvider();
      expect(rail.isAvailable()).toBe(true);
      expect((await rail.pay(request('100012345678'))).outcome).toBe(PayoutOutcome.PAID);
      expect((await rail.pay(request('100012345678'))).outcome).toBe(PayoutOutcome.ALREADY_PAID);
    });

    it('declines …0000, and reports …9999 UNKNOWN until a status check confirms it', async () => {
      const rail = new MockPayoutProvider();
      expect(await rail.pay(request('5550000', 'PAYOUT-d'))).toMatchObject({ outcome: PayoutOutcome.FAILED });
      expect((await rail.pay(request('5559999', 'PAYOUT-u'))).outcome).toBe(PayoutOutcome.UNKNOWN);
      expect((await rail.getStatus('PAYOUT-u')).outcome).toBe(PayoutOutcome.PAID);
    });
  });

  describe('UnavailablePayoutProvider (production)', () => {
    it('is unavailable and refuses every call', async () => {
      const rail: IPayoutProviderPort = new UnavailablePayoutProvider();
      expect(rail.isAvailable()).toBe(false);
      await expect(rail.pay(request('100012345678'))).rejects.toBeInstanceOf(ApiException);
      await expect(rail.getStatus('PAYOUT-x')).rejects.toBeInstanceOf(ApiException);
    });
  });

  describe('RBAC', () => {
    it('grants finance:payout:any to FINANCE_OFFICER (SUPER_ADMIN by wildcard) only, apart from finance:settlement:any', () => {
      expect(PERMISSIONS.find((p) => p.key === 'finance:payout:any')).toEqual({
        key: 'finance:payout:any',
        resource: 'finance',
        action: 'payout',
        scope: 'any',
      });
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'finance:payout:any') }).toEqual({
          role,
          ok: role === 'FINANCE_OFFICER' || role === 'SUPER_ADMIN',
        });
      }
      expect(hasPermission(['finance:settlement:any'], 'finance:payout:any')).toBe(false);
    });

    it('guards approve and reads with finance:settlement:any, and every money move with finance:payout:any', () => {
      const proto = AdminSettlementPayoutController.prototype;
      const perm = (m: keyof typeof proto) => Reflect.getMetadata(PERMISSIONS_KEY, proto[m]);
      expect(perm('approve')).toEqual(['finance:settlement:any']);
      expect(perm('payout')).toEqual(['finance:settlement:any']);
      expect(perm('beneficiaries')).toEqual(['finance:settlement:any']);
      for (const m of ['pay', 'refresh', 'register', 'verify'] as const) expect(perm(m)).toEqual(['finance:payout:any']);
    });
  });
});
