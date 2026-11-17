import { authService, type SessionRequest } from './auth.service';

/**
 * The prescription file behind an order (Work 132; owner decision 2026-11-16). The pharmacist
 * reviews the prescription inside the order (see `pharmacyOrders.service`); this opens its file.
 * The route needs `prescription:verify` and the PHARMACIST role at the pharmacy filling the order,
 * and the file opens only through the audited, short-lived preview link.
 */

export interface FilePreview {
  url: string;
  expiresAt: string;
  contentType: string;
}

export function createPrescriptionReviewService(request: SessionRequest) {
  return {
    /** A short-lived link to the file; the server records each one. */
    filePreview(prescriptionId: string): Promise<FilePreview> {
      return request<FilePreview>(`/pharmacy/verification/${encodeURIComponent(prescriptionId)}/file`, { method: 'POST' });
    },
  };
}

export const prescriptionReviewService = createPrescriptionReviewService(authService.request);
