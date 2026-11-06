import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { NotificationTemplateCode, renderNotification } from '../../notifications/domain/templates';
import { CustomerReviewsController } from '../interface/reviews.controllers';
import { aggregate, autoFlags, EDIT_WINDOW_DAYS, MODERATION_MOVES, normalizeContent, REPORTS_TO_FLAG, withinEditWindow } from './review-policy';

describe('Review policy (Work 91)', () => {
  it('accepts whole ratings 1–5 and trims text, refusing anything else', () => {
    expect(normalizeContent({ rating: 5, title: '  Good  ', body: '  ' })).toEqual({ rating: 5, title: 'Good', body: null });
    for (const rating of [0, 6, 2.5, Number.NaN]) expect(() => normalizeContent({ rating })).toThrow();
    expect(() => normalizeContent({ rating: 3, title: 'x'.repeat(121) })).toThrow();
    expect(() => normalizeContent({ rating: 3, body: 'x'.repeat(2001) })).toThrow();
  });

  it('holds links, e-mail addresses and Ethiopian phone numbers, and nothing ordinary', () => {
    expect(autoFlags({ title: null, body: 'Visit https://x.example now' })).toEqual(['LINK']);
    expect(autoFlags({ title: 'www.x.example', body: null })).toEqual(['LINK']);
    expect(autoFlags({ title: null, body: 'mail me: a.b+c@d.example' })).toEqual(['EMAIL']);
    for (const phone of ['0911234567', '0911 234 567', '+251 911 234 567', '+251-7-1234-5678', '0712345678']) {
      expect({ phone, flags: autoFlags({ title: null, body: `call ${phone}` }) }).toEqual({ phone, flags: ['PHONE'] });
    }
    expect(autoFlags({ title: 'Great service', body: 'Ready in 15 minutes, paid 250 birr, 5 stars.' })).toEqual([]);
  });

  it('allows edits for 14 days', () => {
    const created = new Date('2026-11-01T00:00:00Z');
    expect(EDIT_WINDOW_DAYS).toBe(14);
    expect(withinEditWindow(created, new Date('2026-11-15T00:00:00Z'))).toBe(true);
    expect(withinEditWindow(created, new Date('2026-11-15T00:00:01Z'))).toBe(false);
  });

  it('aggregates count, mean to two places and the star distribution', () => {
    expect(aggregate([])).toEqual({ ratingCount: 0, ratingAvg: 0, distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } });
    expect(aggregate([5, 4, 4])).toEqual({ ratingCount: 3, ratingAvg: 4.33, distribution: { '1': 0, '2': 0, '3': 0, '4': 2, '5': 1 } });
  });

  it('allows only the moderation moves BRULE-46 describes', () => {
    expect(MODERATION_MOVES.hide.from).toEqual(['PUBLISHED', 'FLAGGED']);
    expect(MODERATION_MOVES.remove.from).toEqual(['PUBLISHED', 'FLAGGED', 'HIDDEN']);
    expect(MODERATION_MOVES.restore.from).toEqual(['FLAGGED', 'HIDDEN']);
    expect(REPORTS_TO_FLAG).toBe(3);
  });

  it('tells the author in English and Amharic, without the reason or the moderator', () => {
    for (const move of ['hide', 'remove', 'restore']) {
      for (const language of ['en', 'am']) {
        const n = renderNotification(NotificationTemplateCode.REVIEW_MODERATED, language, { move });
        expect(n.title.length).toBeGreaterThan(0);
        expect(n.body.length).toBeGreaterThan(0);
      }
    }
    expect(renderNotification(NotificationTemplateCode.REVIEW_MODERATED, 'en', { move: 'restore' }).body).toBe('Your review is visible again.');
  });

  it('lets customers write reviews and only administrators moderate', () => {
    expect(PERMISSIONS.some((p) => p.key === 'review:create:own')).toBe(true);
    expect(hasPermission(ROLE_PERMISSIONS.CUSTOMER, 'review:create:own')).toBe(true);
    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      expect({ role, ok: hasPermission(grants, 'review:moderate:any') }).toEqual({ role, ok: ['ADMIN', 'SUPER_ADMIN'].includes(role) });
    }
    expect(Reflect.getMetadata(PERMISSIONS_KEY, CustomerReviewsController)).toEqual(['review:create:own']);
  });
});
