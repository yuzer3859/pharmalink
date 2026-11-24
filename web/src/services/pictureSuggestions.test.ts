import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import { createAdminCatalogService, isValidPictureRejectReason } from './adminCatalog.service';
import { createPharmacyInventoryService } from './pharmacyInventory.service';
import type { SessionRequest } from './auth.service';

const LISTING = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';

describe('pictures suggested by pharmacies (Work 151)', () => {
  it('the pharmacy reads its listing’s pictures and suggestions', async () => {
    const request = vi.fn(async () => ({ images: ['/products/a.webp'], suggestions: [] })) as unknown as SessionRequest;
    expect(await createPharmacyInventoryService(request).pictures(LISTING)).toEqual({ images: ['/products/a.webp'], suggestions: [] });
    expect(request).toHaveBeenCalledWith(`/inventory/listings/${LISTING}/pictures`, { method: 'GET' });
  });

  it('uploads the file through its own listing, then sends the picture for review', async () => {
    const imageUrl = `/media/catalog/${PRODUCT}/obj`;
    const request = vi.fn(async (path: string) =>
      path.endsWith('/uploads')
        ? { imageUrl, upload: { url: 'https://storage.test/put?sig=1', method: 'PUT', headers: {} } }
        : { id: 's1', productId: PRODUCT, imageUrl, status: 'PENDING', reason: null, createdAt: '2026-11-24T08:00:00Z', decidedAt: null },
    ) as unknown as SessionRequest;
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    const file = new File([new Uint8Array(12)], 'pack.webp', { type: 'image/webp' });

    const suggestion = await createPharmacyInventoryService(request).suggestPicture(LISTING, file, put as unknown as typeof fetch);
    expect(suggestion.status).toBe('PENDING');
    expect(request).toHaveBeenNthCalledWith(1, `/inventory/listings/${LISTING}/pictures/uploads`, { method: 'POST', body: { contentType: 'image/webp', bytes: 12 } });
    expect(put).toHaveBeenCalledWith('https://storage.test/put?sig=1', expect.objectContaining({ method: 'PUT', body: file }));
    expect(request).toHaveBeenNthCalledWith(2, `/inventory/listings/${LISTING}/pictures/suggestions`, { method: 'POST', body: { imageUrl } });
  });

  it('refuses a wrong file before asking, and never suggests a picture that failed to upload', async () => {
    const request = vi.fn(async () => ({ imageUrl: 'x', upload: { url: 'https://s.test/p', method: 'PUT', headers: {} } })) as unknown as SessionRequest;
    const service = createPharmacyInventoryService(request);
    await expect(service.suggestPicture(LISTING, new File(['x'], 'a.gif', { type: 'image/gif' }))).rejects.toBeInstanceOf(ApiError);
    expect(request).not.toHaveBeenCalled();

    const failing = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(service.suggestPicture(LISTING, new File(['x'], 'a.png', { type: 'image/png' }), failing as unknown as typeof fetch)).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('catalogue staff list the waiting pictures, approve one, or turn one down with a reason', async () => {
    const request = vi.fn(async () => ({})) as unknown as SessionRequest;
    const service = createAdminCatalogService(request);
    await service.pictureSuggestions({ page: 2, size: 6 });
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/picture-suggestions?status=PENDING&page=2&size=6', { method: 'GET' });
    await service.approvePictureSuggestion('s1');
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/picture-suggestions/s1/approve', { method: 'POST' });
    await service.rejectPictureSuggestion('s1', '  Shows a logo. ');
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/picture-suggestions/s1/reject', { method: 'POST', body: { reason: 'Shows a logo.' } });

    expect(isValidPictureRejectReason('  no ')).toBe(false);
    expect(isValidPictureRejectReason('Blurry')).toBe(true);
    expect(isValidPictureRejectReason('x'.repeat(301))).toBe(false);
  });
});
