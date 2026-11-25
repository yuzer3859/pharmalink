import { narrowToSelectedOrganization, runWithSelectedOrganization, selectedOrganization, SelectedOrganizationMiddleware } from './selected-organization';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('the organisation a request works in (Work 155)', () => {
  it('without a choice, every organisation is kept', () => {
    expect(selectedOrganization()).toBeNull();
    expect(narrowToSelectedOrganization([A, B])).toEqual([A, B]);
  });

  it('keeps only the chosen one, any case; none when the caller holds no role there', () => {
    runWithSelectedOrganization(B.toUpperCase(), () => {
      expect(selectedOrganization()).toBe(B);
      expect(narrowToSelectedOrganization([A, B])).toEqual([B]);
      expect(narrowToSelectedOrganization([A])).toEqual([]);
    });
  });

  it('ignores anything that is not an id, and survives awaits', async () => {
    runWithSelectedOrganization('drop table', () => expect(narrowToSelectedOrganization([A, B])).toEqual([A, B]));
    await runWithSelectedOrganization(A, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(narrowToSelectedOrganization([A, B])).toEqual([A]);
    });
  });

  it('the middleware reads the X-Organization-Id header for the rest of the request', () => {
    let seen: string | null = 'unset';
    const req = { header: (name: string) => (name === 'x-organization-id' ? ` ${A} ` : undefined) };
    new SelectedOrganizationMiddleware().use(req as never, {} as never, () => {
      seen = selectedOrganization();
    });
    expect(seen).toBe(A);
  });
});
