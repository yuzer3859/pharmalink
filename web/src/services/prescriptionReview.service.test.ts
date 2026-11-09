import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import { approvalProblem, createPrescriptionReviewService, noteProblem, reviewQueueQuery } from './prescriptionReview.service';

const line = { catalogProductId: 'p-1', approvedQuantity: 2, refillsAllowed: 0, isSingleUse: false };

describe('approvalProblem', () => {
  it('needs both attestations, at least one line, and the server’s number rules', () => {
    expect(approvalProblem({ lines: [line], legibilityOk: true, validityOk: true })).toBeNull();
    expect(approvalProblem({ lines: [line], legibilityOk: false, validityOk: true })).not.toBeNull();
    expect(approvalProblem({ lines: [line], legibilityOk: true, validityOk: false })).not.toBeNull();
    expect(approvalProblem({ lines: [], legibilityOk: true, validityOk: true })).not.toBeNull();
    expect(approvalProblem({ lines: [{ ...line, approvedQuantity: 0 }], legibilityOk: true, validityOk: true })).not.toBeNull();
    expect(approvalProblem({ lines: [{ ...line, approvedQuantity: 1.5 }], legibilityOk: true, validityOk: true })).not.toBeNull();
    expect(approvalProblem({ lines: [{ ...line, refillsAllowed: -1 }], legibilityOk: true, validityOk: true })).not.toBeNull();
  });
});

describe('noteProblem', () => {
  it('follows the server rule for reasons and messages: 3 to 500 characters after trimming', () => {
    expect(noteProblem(' ab ')).not.toBeNull();
    expect(noteProblem('Illegible dose')).toBeNull();
    expect(noteProblem('x'.repeat(501))).not.toBeNull();
  });
});

describe('reviewQueueQuery', () => {
  it('sends paging only when set, capped at the server’s 50', () => {
    expect(reviewQueueQuery()).toBe('');
    expect(reviewQueueQuery(2, 25)).toBe('?page=2&size=25');
    expect(reviewQueueQuery(1, 500)).toBe('?page=1&size=50');
  });
});

describe('prescriptionReviewService', () => {
  it('reads the queue and one prescription, and asks for the audited file link', async () => {
    const request = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const service = createPrescriptionReviewService(request as unknown as SessionRequest);

    await service.queue(1, 25);
    expect(request).toHaveBeenLastCalledWith('/pharmacy/verification/queue?page=1&size=25', { method: 'GET' });
    await service.get('rx/1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/verification/rx%2F1', { method: 'GET' });
    await service.filePreview('rx-1');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/verification/rx-1/file', { method: 'POST' });
  });

  it('posts each decision to its route with its body', async () => {
    const request = vi.fn().mockResolvedValue({});
    const service = createPrescriptionReviewService(request as unknown as SessionRequest);
    const approval = { lines: [line], legibilityOk: true, validityOk: true };

    await service.approve('rx-1', approval);
    expect(request).toHaveBeenLastCalledWith('/pharmacy/verification/rx-1/approve', { method: 'POST', body: approval });
    await service.reject('rx-1', '  Illegible dose ');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/verification/rx-1/reject', { method: 'POST', body: { reason: 'Illegible dose' } });
    await service.clarify('rx-1', ' Which strength? ');
    expect(request).toHaveBeenLastCalledWith('/pharmacy/verification/rx-1/clarify', { method: 'POST', body: { message: 'Which strength?' } });
  });

  it('offers no other operation', () => {
    const service = createPrescriptionReviewService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(service).sort()).toEqual(['approve', 'clarify', 'filePreview', 'get', 'queue', 'reject']);
  });
});
