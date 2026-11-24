import type { CatalogHistory, CatalogProductStatus, CatalogProductType, CatalogReviewPage, CatalogReviewSummary } from '@/types';
import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';
import { API_BASE_URL, CUSTOMER_APP_URL } from '@/config/env';

// ---- Work 150: product pictures ----------------------------------------------------------------

export const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
export const MAX_PICTURES = 8;

/** Why a file can't be a product picture, or null when it can. */
export function pictureProblem(file: { type: string; size: number }): string | null {
  if (!(PICTURE_TYPES as readonly string[]).includes(file.type)) return 'Choose a JPEG, PNG or WebP picture.';
  if (file.size < 1 || file.size > MAX_PICTURE_BYTES) return 'A picture must be smaller than 5 MB.';
  return null;
}

/**
 * Where to load a saved picture from: an uploaded one (`/media/…`) from the API, one shipped with
 * the customer app (`/products/…`) from that app, an https URL as it is; anything else, nowhere.
 */
export function pictureSrc(url: string): string | null {
  if (/^https:\/\/[^\s"'<>]+$/.test(url)) return url;
  if (url.startsWith('/media/')) return `${API_BASE_URL}${url}`;
  if (/^\/(?!\/)[^\s"'<>]*$/.test(url)) return `${CUSTOMER_APP_URL}${url}`;
  return null;
}

/** Moves the picture at `from` to `to` (the first is the main picture). */
export function movePicture(list: string[], from: number, to: number): string[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [picked] = next.splice(from, 1);
  next.splice(to, 0, picked);
  return next;
}

export interface PictureUpload {
  imageUrl: string;
  upload: { url: string; method: 'PUT' | 'GET'; headers: Record<string, string> };
}

/** Filters of `GET /admin/catalog/review` (`catalog:manage:any`). */
export interface CatalogReviewFilters {
  status?: CatalogProductStatus | 'all';
  type?: CatalogProductType | 'all';
  /** Name search, 1–100 characters (the server's bound). */
  q?: string;
  /** 1-based. */
  page?: number;
  size?: number;
}

export const CATALOG_STATUSES: CatalogProductStatus[] = ['PENDING_REVIEW', 'DRAFT', 'ACTIVE', 'REJECTED', 'DEPRECATED', 'DELISTED'];
export const CATALOG_TYPES: CatalogProductType[] = ['MEDICINE', 'HEALTH_PRODUCT'];
export const CATALOG_PAGE_SIZES = [10, 25, 50] as const;
export const MIN_CATALOG_REJECT_REASON = 3;
export const MAX_CATALOG_REJECT_REASON = 300;

/** The review decisions this page offers, by the status they start from. */
export type CatalogAction = 'submit' | 'approve' | 'reject' | 'resubmit';
const ACTION_FROM: Record<CatalogAction, CatalogProductStatus> = {
  submit: 'DRAFT',
  approve: 'PENDING_REVIEW',
  reject: 'PENDING_REVIEW',
  resubmit: 'REJECTED',
};
const ACTION_TO: Record<CatalogAction, CatalogProductStatus> = {
  submit: 'PENDING_REVIEW',
  approve: 'ACTIVE',
  reject: 'REJECTED',
  resubmit: 'PENDING_REVIEW',
};

/**
 * The actions available for a product: its status must be the one the route starts from, and the
 * server must list the target in the row's `allowedTransitions`. The server decides; this only
 * avoids offering a button it would refuse.
 */
export function availableActions(product: { status: CatalogProductStatus; allowedTransitions: string[] }): CatalogAction[] {
  return (Object.keys(ACTION_FROM) as CatalogAction[]).filter(
    (action) => product.status === ACTION_FROM[action] && product.allowedTransitions.includes(ACTION_TO[action]),
  );
}

export const isSearchFilter = (value: string) => {
  const v = value.trim();
  return v.length >= 1 && v.length <= 100;
};

export const isValidCatalogRejectReason = (value: string) => {
  const v = value.trim();
  return v.length >= MIN_CATALOG_REJECT_REASON && v.length <= MAX_CATALOG_REJECT_REASON;
};

export function catalogReviewQuery(filters: CatalogReviewFilters): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.type && filters.type !== 'all') params.set('type', filters.type);
  const q = filters.q?.trim();
  if (q) params.set('q', q);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** A product's display name: brand, then generic, then the English or Amharic name. */
export const productName = (p: { brandName: string | null; genericName: string | null; nameEn: string | null; nameAm: string | null }) =>
  p.brandName ?? p.genericName ?? p.nameEn ?? p.nameAm ?? 'Unnamed product';

export function catalogErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 403) return 'Your account is not allowed to review the catalogue.';
  if (error.status === 404) return 'That product no longer exists.';
  return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
}

export function createAdminCatalogService(request: SessionRequest) {
  const product = (id: string) => `/admin/catalog/review/${encodeURIComponent(id)}`;
  const decide = (id: string, action: CatalogAction, body?: unknown) =>
    request<unknown>(`${product(id)}/${action}`, body === undefined ? { method: 'POST' } : { method: 'POST', body });
  return {
    list(filters: CatalogReviewFilters = {}): Promise<CatalogReviewPage> {
      return request<CatalogReviewPage>(`/admin/catalog/review${catalogReviewQuery(filters)}`, { method: 'GET' });
    },
    summary(): Promise<CatalogReviewSummary> {
      return request<CatalogReviewSummary>('/admin/catalog/review/summary', { method: 'GET' });
    },
    history(id: string): Promise<CatalogHistory> {
      return request<CatalogHistory>(`${product(id)}/history`, { method: 'GET' });
    },
    submit: (id: string) => decide(id, 'submit'),
    approve: (id: string) => decide(id, 'approve'),
    resubmit: (id: string) => decide(id, 'resubmit'),
    reject: (id: string, reason: string) => decide(id, 'reject', { reason: reason.trim() }),

    /** Work 150: the product's pictures, main first. */
    async pictures(id: string): Promise<string[]> {
      const detail = await request<{ images?: string[] }>(`/admin/catalog/products/${encodeURIComponent(id)}`, { method: 'GET' });
      return Array.isArray(detail.images) ? detail.images : [];
    },
    /** Asks for an upload link, sends the file straight to storage, and returns the picture's URL. */
    async uploadPicture(id: string, file: File, put: typeof fetch = (...args) => fetch(...args)): Promise<string> {
      const problem = pictureProblem(file);
      if (problem) throw new ApiError(400, 'VALIDATION_ERROR', problem);
      const issued = await request<PictureUpload>(`/admin/catalog/products/${encodeURIComponent(id)}/images/uploads`, {
        method: 'POST',
        body: { contentType: file.type, bytes: file.size },
      });
      let stored: Response;
      try {
        stored = await put(issued.upload.url, { method: issued.upload.method, headers: { ...issued.upload.headers, 'Content-Type': file.type }, body: file });
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', 'The picture could not be uploaded. Check the connection and try again.');
      }
      if (!stored.ok) throw new ApiError(stored.status, 'UPLOAD_FAILED', 'The picture could not be uploaded. Try again.');
      return issued.imageUrl;
    },
    /** Saves the pictures in this order; the first is the main one. */
    savePictures(id: string, images: string[]): Promise<{ images: string[] }> {
      return request<{ images: string[] }>(`/admin/catalog/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: { images } });
    },
  };
}

export const adminCatalogService = createAdminCatalogService(authService.request);
