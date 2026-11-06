import { describe, expect, it, vi } from 'vitest';
import { createAdminModerationService, movesFor, portalPathFor } from './adminModeration.service';
import type { SessionRequest } from './auth.service';

describe('adminModerationService (Work 91)', () => {
  it('reads the flagged view and the review queue, and moderates with a trimmed reason', async () => {
    const request = vi.fn().mockResolvedValue({});
    const svc = createAdminModerationService(request as unknown as SessionRequest);
    await svc.flagged();
    expect(request).toHaveBeenLastCalledWith('/admin/moderation/flagged', { method: 'GET' });
    await svc.reviews({ needsAttention: true });
    expect(request).toHaveBeenLastCalledWith('/admin/reviews?needsAttention=true', { method: 'GET' });
    await svc.reviews({ status: 'HIDDEN', page: 2 });
    expect(request).toHaveBeenLastCalledWith('/admin/reviews?status=HIDDEN&page=2', { method: 'GET' });
    await svc.moderate('r 1', 'hide', '  spam  ');
    expect(request).toHaveBeenLastCalledWith('/admin/reviews/r%201/hide', { method: 'POST', body: { reason: 'spam' } });
  });

  it('offers only the moves the server allows', () => {
    expect(movesFor('PUBLISHED')).toEqual(['hide', 'remove']);
    expect(movesFor('FLAGGED')).toEqual(['hide', 'remove', 'restore']);
    expect(movesFor('HIDDEN')).toEqual(['remove', 'restore']);
    expect(movesFor('REMOVED')).toEqual([]);
  });

  it('sends each flagged item to the queue that handles it', () => {
    expect(portalPathFor({ source: 'REVIEW' })).toBe('moderation');
    expect(portalPathFor({ source: 'CATALOG_PRODUCT' })).toBe('catalog-review');
    expect(portalPathFor({ source: 'CONTENT_DISPUTE' })).toBe('disputes');
  });
});
