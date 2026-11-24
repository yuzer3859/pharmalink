import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import { createAdminCatalogService, MAX_PICTURE_BYTES, movePicture, pictureProblem, pictureSrc } from './adminCatalog.service';
import type { SessionRequest } from './auth.service';

const ID = '11111111-1111-4111-8111-111111111111';

describe('product pictures (Work 150)', () => {
  it('accepts only JPEG, PNG or WebP under 5 MB', () => {
    expect(pictureProblem({ type: 'image/png', size: 1000 })).toBeNull();
    expect(pictureProblem({ type: 'image/webp', size: MAX_PICTURE_BYTES })).toBeNull();
    expect(pictureProblem({ type: 'application/pdf', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(pictureProblem({ type: 'image/gif', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(pictureProblem({ type: 'image/jpeg', size: MAX_PICTURE_BYTES + 1 })).toMatch(/5 MB/);
    expect(pictureProblem({ type: 'image/jpeg', size: 0 })).toMatch(/5 MB/);
  });

  it('loads an uploaded picture from the API, a shipped one from the customer app, and nothing unsafe', () => {
    expect(pictureSrc(`/media/catalog/${ID}/x`)).toMatch(/^https?:\/\/[^/]+\/media\/catalog\//);
    expect(pictureSrc('/products/lipstick.webp')).toMatch(/^https?:\/\/[^/]+\/products\/lipstick\.webp$/);
    expect(pictureSrc('https://cdn.example.et/a.jpg')).toBe('https://cdn.example.et/a.jpg');
    for (const bad of ['//evil.example/a.jpg', 'javascript:alert(1)', 'http://plain.example/a.jpg']) expect(pictureSrc(bad)).toBeNull();
  });

  it('moves a picture, and makes one the main picture by moving it first', () => {
    expect(movePicture(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(movePicture(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(movePicture(['a', 'b'], 1, 5)).toEqual(['a', 'b']);
  });

  it('asks for an upload link, sends the file straight to storage, and returns the picture URL', async () => {
    const request = vi.fn(async () => ({
      imageUrl: `/media/catalog/${ID}/obj`,
      upload: { url: 'https://storage.test/put?sig=1', method: 'PUT', headers: { 'Content-Type': 'image/png' } },
    })) as unknown as SessionRequest;
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    const file = new File([new Uint8Array(10)], 'pills.png', { type: 'image/png' });

    const url = await createAdminCatalogService(request).uploadPicture(ID, file, put as unknown as typeof fetch);
    expect(url).toBe(`/media/catalog/${ID}/obj`);
    expect(request).toHaveBeenCalledWith(`/admin/catalog/products/${ID}/images/uploads`, { method: 'POST', body: { contentType: 'image/png', bytes: 10 } });
    expect(put).toHaveBeenCalledWith('https://storage.test/put?sig=1', expect.objectContaining({ method: 'PUT', body: file }));
  });

  it('refuses a wrong file before asking, and reports a failed upload', async () => {
    const request = vi.fn(async () => ({ imageUrl: 'x', upload: { url: 'https://s.test/p', method: 'PUT', headers: {} } })) as unknown as SessionRequest;
    const service = createAdminCatalogService(request);
    await expect(service.uploadPicture(ID, new File(['x'], 'a.pdf', { type: 'application/pdf' }))).rejects.toBeInstanceOf(ApiError);
    expect(request).not.toHaveBeenCalled();

    const failing = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(service.uploadPicture(ID, new File(['x'], 'a.png', { type: 'image/png' }), failing as unknown as typeof fetch)).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
  });

  it('reads and saves the pictures in order', async () => {
    const request = vi.fn(async (_path: string, options?: { method?: string }) =>
      options?.method === 'GET' ? { id: ID, images: ['/products/a.webp'] } : { images: ['b', 'a'] },
    ) as unknown as SessionRequest;
    const service = createAdminCatalogService(request);
    expect(await service.pictures(ID)).toEqual(['/products/a.webp']);
    await service.savePictures(ID, ['b', 'a']);
    expect(request).toHaveBeenLastCalledWith(`/admin/catalog/products/${ID}`, { method: 'PATCH', body: { images: ['b', 'a'] } });
  });
});
