/**
 * Work 167: turning a doctor's availability rules into bookable slots (module-10 §3.2, §11.4).
 * Pure functions, no I/O. Rule times are local Ethiopian time (UTC+3 all year; Ethiopia keeps no
 * daylight saving), so a 09:00 rule is a 06:00Z slot.
 */

export const ETHIOPIA_UTC_OFFSET_MINUTES = 3 * 60;
/** How far ahead slots exist (F-AVL-04). */
export const BOOKING_HORIZON_DAYS = 60;
export const DEFAULT_SLOT_MINUTES = 30;

export type RuleType = 'RECURRING' | 'EXCEPTION_AVAILABLE' | 'EXCEPTION_BLOCK';
export type SlotType = 'IN_PERSON' | 'TELEMEDICINE' | 'BOTH';

export interface RuleInput {
  id: string;
  type: RuleType;
  /** RECURRING: 0 = Sunday … 6 = Saturday. */
  weekday: number | null;
  /** `HH:MM` local; a BLOCK without times blocks the whole day. */
  startTime: string | null;
  endTime: string | null;
  /** RECURRING: when the pattern starts and stops applying; exceptions: the day (validFrom). */
  validFrom: Date | null;
  validTo: Date | null;
  slotDurationMinutes: number | null;
  bufferMinutes: number | null;
  appointmentType: SlotType;
  providerLocationId: string | null;
}

export interface GeneratedSlot {
  startAt: Date;
  endAt: Date;
  appointmentType: SlotType;
  providerLocationId: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The local (Ethiopian) calendar date of an instant, as `YYYY-MM-DD`. */
export function localDate(at: Date): string {
  return new Date(at.getTime() + ETHIOPIA_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** The instant of a local date and `HH:MM`. */
export function localInstant(date: string, hhmm: string): Date {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + (minutesOf(hhmm) - ETHIOPIA_UTC_OFFSET_MINUTES) * 60_000);
}

/** The local weekday (0 = Sunday) of a `YYYY-MM-DD` date. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00.000Z`).getUTCDay();

/** Every local date from `from` for `days` days. */
export function dates(from: Date, days: number): string[] {
  const first = Date.parse(`${localDate(from)}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, i) => new Date(first + i * DAY_MS).toISOString().slice(0, 10));
}

function windowSlots(date: string, rule: RuleInput): GeneratedSlot[] {
  if (!rule.startTime || !rule.endTime) return [];
  const length = rule.slotDurationMinutes ?? DEFAULT_SLOT_MINUTES;
  const step = length + (rule.bufferMinutes ?? 0);
  const out: GeneratedSlot[] = [];
  const end = minutesOf(rule.endTime);
  for (let m = minutesOf(rule.startTime); m + length <= end; m += step) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const startAt = localInstant(date, `${hh}:${mm}`);
    out.push({ startAt, endAt: new Date(startAt.getTime() + length * 60_000), appointmentType: rule.appointmentType, providerLocationId: rule.providerLocationId });
  }
  return out;
}

const onDay = (rule: RuleInput, date: string) => !!rule.validFrom && localDate(rule.validFrom) === date;

function appliesOn(rule: RuleInput, date: string): boolean {
  if (rule.type !== 'RECURRING') return onDay(rule, date);
  if (rule.weekday !== weekdayOf(date)) return false;
  if (rule.validFrom && date < localDate(rule.validFrom)) return false;
  if (rule.validTo && date > localDate(rule.validTo)) return false;
  return true;
}

/** Whether a slot falls in a BLOCK exception (a whole day, or overlapping its hours). */
export function isBlocked(slot: { startAt: Date; endAt: Date }, rules: RuleInput[]): boolean {
  const date = localDate(slot.startAt);
  return rules.some((r) => {
    if (r.type !== 'EXCEPTION_BLOCK' || !onDay(r, date)) return false;
    if (!r.startTime || !r.endTime) return true;
    return slot.startAt < localInstant(date, r.endTime) && slot.endAt > localInstant(date, r.startTime);
  });
}

/**
 * The open slots the rules give from `from` (inclusive) for the horizon: recurring patterns and
 * one-off extra availability, minus blocked times, never in the past, one per start and type.
 */
export function generateSlots(rules: RuleInput[], from: Date, horizonDays = BOOKING_HORIZON_DAYS): GeneratedSlot[] {
  const seen = new Set<string>();
  const out: GeneratedSlot[] = [];
  for (const date of dates(from, horizonDays)) {
    for (const rule of rules) {
      if (rule.type === 'EXCEPTION_BLOCK' || !appliesOn(rule, date)) continue;
      for (const slot of windowSlots(date, rule)) {
        const key = `${slot.startAt.toISOString()}|${slot.appointmentType}`;
        if (slot.startAt <= from || seen.has(key) || isBlocked(slot, rules)) continue;
        seen.add(key);
        out.push(slot);
      }
    }
  }
  return out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}
