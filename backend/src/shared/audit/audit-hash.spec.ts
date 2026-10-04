import {
  AuditChainEntry,
  AuditHashInput,
  computeEntryHash,
  verifyChain,
} from './audit-hash';

function entry(action: string, prevHash: string | null): AuditChainEntry {
  const input: AuditHashInput = {
    actorUserId: 'user-1',
    action,
    resourceType: 'order',
    resourceId: 'order-1',
    context: { note: action },
    ip: '10.0.0.1',
    createdAt: `2026-01-01T00:00:0${action.length}.000Z`,
  };
  return { ...input, prevHash, hash: computeEntryHash(prevHash, input) };
}

describe('audit hash chain', () => {
  it('computeEntryHash is deterministic and order-independent for context keys', () => {
    const base: AuditHashInput = {
      actorUserId: 'u',
      action: 'a',
      resourceType: 'r',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const h1 = computeEntryHash(null, { ...base, context: { a: 1, b: 2 } });
    const h2 = computeEntryHash(null, { ...base, context: { b: 2, a: 1 } });
    expect(h1).toBe(h2);
  });

  it('different content yields a different hash', () => {
    const a = computeEntryHash(null, {
      action: 'a',
      resourceType: 'r',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const b = computeEntryHash(null, {
      action: 'b',
      resourceType: 'r',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(a).not.toBe(b);
  });

  it('verifyChain returns -1 for an intact chain', () => {
    const e1 = entry('create', null);
    const e2 = entry('update', e1.hash);
    const e3 = entry('delete', e2.hash);
    expect(verifyChain([e1, e2, e3])).toBe(-1);
  });

  it('detects a tampered payload at its index', () => {
    const e1 = entry('create', null);
    const e2 = entry('update', e1.hash);
    const tampered: AuditChainEntry = { ...e2, action: 'update-EVIL' };
    expect(verifyChain([e1, tampered])).toBe(1);
  });

  it('detects a broken prevHash link', () => {
    const e1 = entry('create', null);
    const e2 = entry('update', 'not-the-real-prev-hash');
    expect(verifyChain([e1, e2])).toBe(1);
  });
});
