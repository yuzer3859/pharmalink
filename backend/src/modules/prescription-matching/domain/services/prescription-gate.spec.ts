import { PrescriptionGate } from './prescription-gate';
import { ErrorCode } from '../../../../shared/errors/error-codes';

describe('PrescriptionGate', () => {
  const now = new Date('2026-06-01T00:00:00Z');

  it('always allows an OTC line, even with no candidate lines at all', () => {
    const result = PrescriptionGate.check([{ catalogProductId: 'p1', isRx: false, quantity: 2 }], [], now);
    expect(result.allowed).toBe(true);
    expect(result.blocked).toEqual([]);
  });

  it('blocks an Rx line with RX_REQUIRED when no candidate line exists for that product', () => {
    const result = PrescriptionGate.check(
      [{ catalogProductId: 'p1', isRx: true, quantity: 2 }],
      [],
      now,
    );
    expect(result.allowed).toBe(false);
    expect(result.blocked).toEqual([{ catalogProductId: 'p1', reason: ErrorCode.RX_REQUIRED }]);
  });

  it('blocks an Rx line with PRESCRIPTION_EXPIRED when the only matching line is expired', () => {
    const result = PrescriptionGate.check(
      [{ catalogProductId: 'p1', isRx: true, quantity: 2 }],
      [
        {
          prescriptionLineId: 'line-1',
          catalogProductId: 'p1',
          remainingDispensable: 10,
          expiryDate: new Date('2020-01-01T00:00:00Z'),
        },
      ],
      now,
    );
    expect(result.allowed).toBe(false);
    expect(result.blocked).toEqual([
      { catalogProductId: 'p1', reason: ErrorCode.PRESCRIPTION_EXPIRED },
    ]);
  });

  it('blocks an Rx line with PRESCRIPTION_EXHAUSTED when the matching line lacks sufficient remaining quantity', () => {
    const result = PrescriptionGate.check(
      [{ catalogProductId: 'p1', isRx: true, quantity: 5 }],
      [
        {
          prescriptionLineId: 'line-1',
          catalogProductId: 'p1',
          remainingDispensable: 2,
          expiryDate: null,
        },
      ],
      now,
    );
    expect(result.allowed).toBe(false);
    expect(result.blocked).toEqual([
      { catalogProductId: 'p1', reason: ErrorCode.PRESCRIPTION_EXHAUSTED },
    ]);
  });

  it('allows an Rx line with a sufficient, approved, non-expired line and returns its id', () => {
    const result = PrescriptionGate.check(
      [{ catalogProductId: 'p1', isRx: true, quantity: 5 }],
      [
        {
          prescriptionLineId: 'line-1',
          catalogProductId: 'p1',
          remainingDispensable: 5,
          expiryDate: null,
        },
      ],
      now,
    );
    expect(result.allowed).toBe(true);
    expect(result.blocked).toEqual([]);
    expect(result.usablePrescriptionLineIds).toEqual(['line-1']);
  });

  it('boundary: remainingDispensable exactly equal to requested quantity is usable', () => {
    const result = PrescriptionGate.check(
      [{ catalogProductId: 'p1', isRx: true, quantity: 5 }],
      [
        {
          prescriptionLineId: 'line-1',
          catalogProductId: 'p1',
          remainingDispensable: 5,
          expiryDate: null,
        },
      ],
      now,
    );
    expect(result.allowed).toBe(true);
  });

  it('picks a usable line over an exhausted one when multiple candidates exist for the same product', () => {
    const result = PrescriptionGate.check(
      [{ catalogProductId: 'p1', isRx: true, quantity: 5 }],
      [
        {
          prescriptionLineId: 'exhausted-line',
          catalogProductId: 'p1',
          remainingDispensable: 1,
          expiryDate: null,
        },
        {
          prescriptionLineId: 'usable-line',
          catalogProductId: 'p1',
          remainingDispensable: 10,
          expiryDate: null,
        },
      ],
      now,
    );
    expect(result.allowed).toBe(true);
    expect(result.usablePrescriptionLineIds).toEqual(['usable-line']);
  });

  it('evaluates a mixed cart independently per line (one OTC, one blocked Rx, one allowed Rx)', () => {
    const result = PrescriptionGate.check(
      [
        { catalogProductId: 'otc-1', isRx: false, quantity: 1 },
        { catalogProductId: 'rx-blocked', isRx: true, quantity: 1 },
        { catalogProductId: 'rx-allowed', isRx: true, quantity: 1 },
      ],
      [
        {
          prescriptionLineId: 'line-allowed',
          catalogProductId: 'rx-allowed',
          remainingDispensable: 1,
          expiryDate: null,
        },
      ],
      now,
    );
    expect(result.allowed).toBe(false);
    expect(result.blocked).toEqual([
      { catalogProductId: 'rx-blocked', reason: ErrorCode.RX_REQUIRED },
    ]);
    expect(result.usablePrescriptionLineIds).toEqual(['line-allowed']);
  });
});
