import { generateSlots, isBlocked, localDate, localInstant, weekdayOf, type RuleInput } from './slot-generation';

const rule = (over: Partial<RuleInput>): RuleInput => ({
  id: 'r',
  type: 'RECURRING',
  weekday: 1,
  startTime: '09:00',
  endTime: '11:00',
  validFrom: null,
  validTo: null,
  slotDurationMinutes: 30,
  bufferMinutes: 0,
  appointmentType: 'IN_PERSON',
  providerLocationId: null,
  ...over,
});

// Monday 30 November 2026, 00:00 in Addis Ababa (21:00Z on the 29th).
const MONDAY = localInstant('2026-11-30', '00:00');

describe('slot generation (Work 167)', () => {
  it('works in Ethiopian local time', () => {
    expect(localInstant('2026-11-30', '09:00').toISOString()).toBe('2026-11-30T06:00:00.000Z');
    expect(localDate(new Date('2026-11-29T22:00:00.000Z'))).toBe('2026-11-30');
    expect(weekdayOf('2026-11-30')).toBe(1);
  });

  it('expands a weekly pattern into slots with duration and buffer, never in the past', () => {
    const slots = generateSlots([rule({ bufferMinutes: 10 })], MONDAY, 7);
    expect(slots.map((s) => s.startAt.toISOString())).toEqual(['2026-11-30T06:00:00.000Z', '2026-11-30T06:40:00.000Z', '2026-11-30T07:20:00.000Z']);
    expect(slots[0].endAt.toISOString()).toBe('2026-11-30T06:30:00.000Z');
    // From 10:00 on Monday, only the 10:20 slot is still ahead that day; next Monday is beyond 7 days.
    expect(generateSlots([rule({ bufferMinutes: 10 })], localInstant('2026-11-30', '10:00'), 7).map((s) => s.startAt.toISOString())).toEqual(['2026-11-30T07:20:00.000Z']);
    expect(generateSlots([rule({})], MONDAY, 14)).toHaveLength(8);
  });

  it('respects when a pattern starts and stops, and adds one-off availability', () => {
    const later = rule({ validFrom: localInstant('2026-12-07', '00:00') });
    expect(generateSlots([later], MONDAY, 14).every((s) => localDate(s.startAt) === '2026-12-07')).toBe(true);
    const extra = rule({ type: 'EXCEPTION_AVAILABLE', weekday: null, validFrom: localInstant('2026-12-02', '00:00'), startTime: '14:00', endTime: '15:00' });
    expect(generateSlots([extra], MONDAY, 7).map((s) => s.startAt.toISOString())).toEqual(['2026-12-02T11:00:00.000Z', '2026-12-02T11:30:00.000Z']);
  });

  it('blocks a whole day off, or just the hours that overlap', () => {
    const dayOff = rule({ id: 'b', type: 'EXCEPTION_BLOCK', weekday: null, validFrom: localInstant('2026-11-30', '00:00'), startTime: null, endTime: null });
    expect(generateSlots([rule({}), dayOff], MONDAY, 7)).toEqual([]);
    const meeting = rule({ id: 'b', type: 'EXCEPTION_BLOCK', weekday: null, validFrom: localInstant('2026-11-30', '00:00'), startTime: '09:45', endTime: '10:15' });
    expect(generateSlots([rule({}), meeting], MONDAY, 7).map((s) => s.startAt.toISOString())).toEqual(['2026-11-30T06:00:00.000Z', '2026-11-30T07:30:00.000Z']);
    expect(isBlocked({ startAt: localInstant('2026-11-30', '10:15'), endAt: localInstant('2026-11-30', '10:45') }, [meeting])).toBe(false);
  });

  it('gives one slot per start and type when patterns overlap', () => {
    expect(generateSlots([rule({ id: 'a' }), rule({ id: 'b' })], MONDAY, 7)).toHaveLength(4);
    expect(generateSlots([rule({ id: 'a' }), rule({ id: 'b', appointmentType: 'TELEMEDICINE' })], MONDAY, 7)).toHaveLength(8);
  });
});
