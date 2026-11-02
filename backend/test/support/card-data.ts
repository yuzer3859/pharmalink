/**
 * Helpers for the PCI assertions ("no card data reaches X"). Persisted rows and response bodies
 * are full of random UUIDs, and a UUID whose first group is all decimal digits (`16701923-8052-…`)
 * is 12 digits joined by a dash — exactly what a PAN-shaped pattern looks for. Scanning raw text
 * therefore fails at random. UUIDs are stripped first: they are identifiers the platform
 * generated, never provider- or customer-supplied text, so removing them hides no card data.
 */

/** Visa test number from the public test-card lists; never a real card. */
export const TEST_PAN = '4111 1111 1111 1111';

/** Same shape the production sanitizer masks: 12-19 digits, optional single space/dash between. */
const PAN_SHAPED = /\b(?:\d[ -]?){11,18}\d\b/;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function withoutUuids(text: string): string {
  return text.replace(UUID, '[uuid]');
}

/** True when `text`, once its UUIDs are removed, still holds a PAN-shaped digit run. */
export function containsPanShapedValue(text: string): boolean {
  return PAN_SHAPED.test(withoutUuids(text));
}

/** True when any recognisable fragment of {@link TEST_PAN} survives, spaced or compact. */
export function containsTestPan(text: string): boolean {
  const scrubbed = withoutUuids(text);
  const compact = TEST_PAN.replace(/\D/g, '');
  return scrubbed.includes(TEST_PAN) || scrubbed.includes(compact) || scrubbed.includes('4111');
}
