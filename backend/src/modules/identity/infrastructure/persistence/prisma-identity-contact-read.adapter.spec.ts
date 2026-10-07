import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { PrismaIdentityContactReadAdapter } from './prisma-identity-contact-read.adapter';

type Row = { phone: string | null; phoneVerifiedAt: Date | null; status: string; deletedAt: Date | null };

/** Module 01's SMS contact contract (module-13 Work 15): who may be texted, and at which number. */
describe('PrismaIdentityContactReadAdapter', () => {
  let rows: Record<string, Row>;
  let selects: unknown[];
  const adapter = () =>
    new PrismaIdentityContactReadAdapter({
      user: {
        findUnique: async (args: { where: { id: string }; select: unknown }) => {
          selects.push(args.select);
          return rows[args.where.id] ?? null;
        },
      },
    } as unknown as PrismaService);
  const verified = new Date('2026-01-01T00:00:00Z');

  beforeEach(() => {
    rows = {};
    selects = [];
  });

  it('a verified phone on an active account is available, in E.164', async () => {
    rows.u = { phone: '+251911223344', phoneVerifiedAt: verified, status: 'ACTIVE', deletedAt: null };
    expect(await adapter().smsRecipientOf('u')).toEqual({ available: true, phone: '+251911223344' });
  });

  it('normalizes a legacy stored form with Module 01’s own PhoneNumber rule', async () => {
    rows.u = { phone: '0911223344', phoneVerifiedAt: verified, status: 'ACTIVE', deletedAt: null };
    expect(await adapter().smsRecipientOf('u')).toEqual({ available: true, phone: '+251911223344' });
  });

  it.each<[string, Row | null, string]>([
    ['an unknown user', null, 'UNKNOWN_USER'],
    ['no phone', { phone: null, phoneVerifiedAt: null, status: 'ACTIVE', deletedAt: null }, 'NO_PHONE'],
    ['a phone that no longer normalizes', { phone: '12345', phoneVerifiedAt: verified, status: 'ACTIVE', deletedAt: null }, 'NO_PHONE'],
    ['an unverified phone', { phone: '+251911223344', phoneVerifiedAt: null, status: 'ACTIVE', deletedAt: null }, 'UNVERIFIED'],
    ['a deactivated account', { phone: '+251911223344', phoneVerifiedAt: verified, status: 'DEACTIVATED', deletedAt: null }, 'INACTIVE'],
    ['a deleted account', { phone: '+251911223344', phoneVerifiedAt: verified, status: 'DELETED', deletedAt: null }, 'INACTIVE'],
    ['an account pending erasure', { phone: '+251911223344', phoneVerifiedAt: verified, status: 'ACTIVE', deletedAt: verified }, 'INACTIVE'],
  ])('%s is unavailable — no fallback number', async (_l, row, reason) => {
    if (row) rows.u = row;
    expect(await adapter().smsRecipientOf('u')).toEqual({ available: false, reason });
  });

  it('a suspended account can still be texted (it is told it was suspended)', async () => {
    rows.u = { phone: '+251911223344', phoneVerifiedAt: verified, status: 'SUSPENDED', deletedAt: null };
    expect(await adapter().smsRecipientOf('u')).toMatchObject({ available: true });
  });

  it('reads four columns — no e-mail, name, password hash, Fayda or role', async () => {
    await adapter().smsRecipientOf('u');
    expect(selects).toEqual([{ phone: true, phoneVerifiedAt: true, status: true, deletedAt: true }]);
  });
});
