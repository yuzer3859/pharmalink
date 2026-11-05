import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import { approvalErrorMessage, createAdminApprovalsService } from './adminApprovals.service';
import type { SessionRequest } from './auth.service';

const service = () => {
  const request = vi.fn().mockResolvedValue({});
  return { request, svc: createAdminApprovalsService(request as unknown as SessionRequest) };
};

describe('adminApprovalsService', () => {
  it('lists with status, mine and paging; "all" and mine=false are left out', async () => {
    const { request, svc } = service();
    await svc.list({ status: 'PENDING', mine: true, page: 2, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/admin/approvals?status=PENDING&mine=true&page=2&size=25', { method: 'GET' });
    await svc.list({ status: 'all', mine: false });
    expect(request).toHaveBeenLastCalledWith('/admin/approvals', { method: 'GET' });
    await svc.get('a/1');
    expect(request).toHaveBeenLastCalledWith('/admin/approvals/a%2F1', { method: 'GET' });
    await svc.actions();
    expect(request).toHaveBeenLastCalledWith('/admin/approvals/actions', { method: 'GET' });
  });

  it('decides with a trimmed reason, and sends no reason when blank; never a checker id', async () => {
    const { request, svc } = service();
    await svc.decide('a1', 'REJECT', '  Wrong account ');
    expect(request).toHaveBeenLastCalledWith('/admin/approvals/a1/decide', {
      method: 'POST',
      body: { decision: 'REJECT', reason: 'Wrong account' },
    });
    await svc.decide('a1', 'APPROVE', '   ');
    expect(request).toHaveBeenLastCalledWith('/admin/approvals/a1/decide', { method: 'POST', body: { decision: 'APPROVE' } });
  });

  it('explains the maker-checker refusals', () => {
    expect(approvalErrorMessage(new ApiError(403, 'MAKER_CHECKER_SELF_APPROVAL', 'x'), 'f')).toMatch(/different administrator/);
    expect(approvalErrorMessage(new ApiError(409, 'APPROVAL_EXPIRED', 'x'), 'f')).toMatch(/expired/);
    expect(approvalErrorMessage(new ApiError(409, 'APPROVAL_ALREADY_DECIDED', 'x'), 'f')).toMatch(/already been decided/);
    expect(
      approvalErrorMessage(
        new ApiError(422, 'RESOLUTION_ACTION_FAILED', 'x', { cause: { code: 'CONFLICT', message: 'Already paid.' } }),
        'f',
      ),
    ).toBe('Approved, but the action could not be carried out: Already paid.');
    expect(approvalErrorMessage(new ApiError(403, 'FORBIDDEN', 'x'), 'f')).toMatch(/not allowed/);
    expect(approvalErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
