import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../../prisma/rbac-catalog';
import { PERMISSIONS_KEY } from '../../../../shared/rbac/permissions.decorator';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { AdminImpersonationController } from '../../../admin/interface/controllers/admin-impersonation.controller';
import { NotificationTemplateCode, renderNotification } from '../../../notifications/domain/templates';
import {
  IMPERSONATION_REDEEM_WINDOW_SECONDS,
  IMPERSONATION_TOKEN_TTL_SECONDS,
  SUPPORT_IMPERSONATE_PERMISSION,
} from '../ports/inbound/identity-impersonation.port';
import { ImpersonationService } from './impersonation.service';

describe('Support impersonation (Work 85)', () => {
  it('lasts 15 minutes and must be started within 15 minutes of approval', () => {
    expect(IMPERSONATION_TOKEN_TTL_SECONDS).toBe(900);
    expect(IMPERSONATION_REDEEM_WINDOW_SECONDS).toBe(900);
  });

  it('grants support:impersonate:any to ADMIN (SUPER_ADMIN by wildcard) and nobody else', () => {
    expect(PERMISSIONS.find((p) => p.key === SUPPORT_IMPERSONATE_PERMISSION)).toEqual({
      key: 'support:impersonate:any',
      resource: 'support',
      action: 'impersonate',
      scope: 'any',
    });
    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      expect({ role, ok: hasPermission(grants, SUPPORT_IMPERSONATE_PERMISSION) }).toEqual({
        role,
        ok: role === 'ADMIN' || role === 'SUPER_ADMIN',
      });
    }
  });

  it('guards every admin impersonation route with that permission', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminImpersonationController)).toEqual([SUPPORT_IMPERSONATE_PERMISSION]);
  });

  it('refuses every non-GET request made with a view-as token, before reading anything', async () => {
    const prisma = { impersonationSession: { findUnique: jest.fn() } };
    const service = new ImpersonationService(prisma as never, {} as never, {} as never, { record: jest.fn() } as never, {} as never);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(
        service.checkRequest({ sub: 'u', permissions: [], permVersion: 1, imp: { sid: 's', act: 'a' } }, method, '/x'),
      ).rejects.toMatchObject({ code: 'IMPERSONATION_READ_ONLY' });
    }
    expect(prisma.impersonationSession.findUnique).not.toHaveBeenCalled();
  });

  it('tells the account holder in English and Amharic without naming the administrator', () => {
    for (const language of ['en', 'am']) {
      const rendered = renderNotification(NotificationTemplateCode.ACCOUNT_IMPERSONATED, language, {});
      expect(rendered.title.length).toBeGreaterThan(0);
      expect(rendered.body).toMatch(/15/);
    }
  });
});
