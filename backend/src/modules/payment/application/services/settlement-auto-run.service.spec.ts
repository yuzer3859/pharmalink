import { dueTrigger } from './settlement-auto-run.service';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('dueTrigger (Work 97: amount threshold or period, whichever comes first)', () => {
  it('nothing payable: never due', () => {
    expect(dueTrigger({ netPayable: 0, since: daysAgo(100), now: NOW, minAmount: 1, periodDays: 1 })).toBeNull();
    expect(dueTrigger({ netPayable: -500, since: daysAgo(100), now: NOW, minAmount: 1, periodDays: 1 })).toBeNull();
  });

  it('the amount trigger fires at the threshold, not below it', () => {
    expect(dueTrigger({ netPayable: 999, since: NOW, now: NOW, minAmount: 1_000, periodDays: 0 })).toBeNull();
    expect(dueTrigger({ netPayable: 1_000, since: NOW, now: NOW, minAmount: 1_000, periodDays: 0 })).toBe('AMOUNT');
  });

  it('the period trigger fires once the days have passed, below any amount', () => {
    expect(dueTrigger({ netPayable: 1, since: daysAgo(6.9), now: NOW, minAmount: 0, periodDays: 7 })).toBeNull();
    expect(dueTrigger({ netPayable: 1, since: daysAgo(7), now: NOW, minAmount: 0, periodDays: 7 })).toBe('PERIOD');
  });

  it('whichever comes first; the amount wins a tie', () => {
    expect(dueTrigger({ netPayable: 10, since: daysAgo(30), now: NOW, minAmount: 1_000, periodDays: 7 })).toBe('PERIOD');
    expect(dueTrigger({ netPayable: 5_000, since: daysAgo(1), now: NOW, minAmount: 1_000, periodDays: 7 })).toBe('AMOUNT');
    expect(dueTrigger({ netPayable: 5_000, since: daysAgo(30), now: NOW, minAmount: 1_000, periodDays: 7 })).toBe('AMOUNT');
  });

  it('0 switches each trigger off', () => {
    expect(dueTrigger({ netPayable: 1_000_000, since: daysAgo(365), now: NOW, minAmount: 0, periodDays: 0 })).toBeNull();
  });
});
