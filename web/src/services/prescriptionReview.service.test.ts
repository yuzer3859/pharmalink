import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import { createPrescriptionReviewService } from './prescriptionReview.service';

describe('prescriptionReviewService', () => {
  it('asks for the audited file link of the prescription on an order, and offers nothing else', async () => {
    const request = vi.fn().mockResolvedValue({ url: 'https://files/x', expiresAt: '2026-11-17T10:05:00Z', contentType: 'application/pdf' });
    const service = createPrescriptionReviewService(request as unknown as SessionRequest);

    await service.filePreview('rx/1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/verification/rx%2F1/file', { method: 'POST' });
    expect(Object.keys(service)).toEqual(['filePreview']);
  });
});
