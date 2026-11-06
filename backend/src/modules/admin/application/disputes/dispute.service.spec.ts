import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../../prisma/rbac-catalog';
import { PERMISSIONS_KEY } from '../../../../shared/rbac/permissions.decorator';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { NotificationTemplateCode, renderNotification } from '../../../notifications/domain/templates';
import { AdminDisputesController, CustomerDisputesController } from '../../interface/controllers/disputes.controllers';
import { DISPUTE_SLA_HOURS, toDisputeView } from './dispute.service';

describe('Disputes (Work 86)', () => {
  it('sets response targets by priority', () => {
    expect(DISPUTE_SLA_HOURS).toEqual({ URGENT: 4, HIGH: 24, NORMAL: 72, LOW: 168 });
  });

  it('flags an open case past its target as overdue, never a resolved one', () => {
    const base = { slaDueAt: new Date(Date.now() - 1000) } as never as Parameters<typeof toDisputeView>[0];
    expect(toDisputeView({ ...base, status: 'INVESTIGATING' } as never).overdue).toBe(true);
    expect(toDisputeView({ ...base, status: 'RESOLVED' } as never).overdue).toBe(false);
    expect(toDisputeView({ slaDueAt: new Date(Date.now() + 60_000), status: 'OPEN' } as never).overdue).toBe(false);
  });

  it('grants the desk to ADMIN and FINANCE_OFFICER and one’s own disputes to CUSTOMER', () => {
    for (const key of ['dispute:manage:any', 'dispute:create:own']) expect(PERMISSIONS.some((p) => p.key === key)).toBe(true);
    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      expect({ role, ok: hasPermission(grants, 'dispute:manage:any') }).toEqual({
        role,
        ok: ['ADMIN', 'FINANCE_OFFICER', 'SUPER_ADMIN'].includes(role),
      });
    }
    expect(hasPermission(ROLE_PERMISSIONS.CUSTOMER, 'dispute:create:own')).toBe(true);
    expect(hasPermission(['dispute:create:own'], 'dispute:manage:any')).toBe(false);
  });

  it('guards the desk and the customer routes with their permissions', () => {
    expect(Reflect.getMetadata('path', AdminDisputesController)).toBe('admin/disputes');
    expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminDisputesController)).toEqual(['dispute:manage:any']);
    expect(Reflect.getMetadata('path', CustomerDisputesController)).toBe('disputes');
    expect(Reflect.getMetadata(PERMISSIONS_KEY, CustomerDisputesController)).toEqual(['dispute:create:own']);
  });

  it('tells the complainant about replies and status changes in English and Amharic', () => {
    for (const language of ['en', 'am']) {
      const reply = renderNotification(NotificationTemplateCode.DISPUTE_UPDATED, language, { caseNumber: 'DSP-1', status: 'RESOLVED', change: 'MESSAGE' });
      expect(reply.title).toContain('DSP-1');
    }
    expect(
      renderNotification(NotificationTemplateCode.DISPUTE_UPDATED, 'en', { caseNumber: 'DSP-1', status: 'RESOLUTION_PENDING', change: 'STATUS' }).body,
    ).toBe('Your dispute is now resolution pending.');
  });
});
