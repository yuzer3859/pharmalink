/**
 * Birr as typed by an operator → santim (Work 84). `null` = empty, `undefined` = not a valid amount.
 * At most two decimals; no thousands separators, signs or exponents.
 */
export function parseBirr(text: string): number | null | undefined {
  const value = text.trim();
  if (value === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
