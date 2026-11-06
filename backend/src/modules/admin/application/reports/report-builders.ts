import { ReportType } from '@prisma/client';

/** The most rows one report holds; past it the file ends and the job says `truncated`. */
export const MAX_REPORT_ROWS = 100_000;
/** Rows read per page from an owner's read port. */
export const REPORT_PAGE_SIZE = 100;
/** The longest window one report may cover. */
export const MAX_REPORT_RANGE_DAYS = 366;

export { ReportType };

/** What each report type needs on top of `report:generate:any` (the type's own read authority). */
export const REPORT_TYPE_PERMISSION: Record<ReportType, string> = {
  PAYMENTS: 'finance:report:any',
  REFUNDS: 'finance:report:any',
  ORDERS: 'order:read:any',
  AUDIT: 'audit:read:any',
  ANALYTICS_DAILY: 'analytics:read',
};

export const REPORT_COLUMNS: Record<ReportType, string[]> = {
  PAYMENTS: ['paymentId', 'orderId', 'customerUserId', 'amountMinor', 'currency', 'method', 'status', 'provider', 'providerRef', 'authorizedAt', 'capturedAt', 'failureReason', 'createdAt'],
  REFUNDS: ['refundId', 'paymentId', 'amountMinor', 'currency', 'type', 'destination', 'status', 'providerRef', 'reason', 'approvedBy', 'createdAt', 'completedAt'],
  ORDERS: ['orderId', 'orderNumber', 'status', 'isCod', 'grandTotalMinor', 'currency', 'lineCount', 'fulfillmentCount', 'placedAt', 'createdAt'],
  AUDIT: ['id', 'createdAt', 'actorUserId', 'action', 'resourceType', 'resourceId', 'ip', 'hash'],
  ANALYTICS_DAILY: ['date', 'metric', 'value'],
};

export type Cell = string | number | boolean | Date | null | undefined;

/**
 * One CSV field (RFC 4180): quoted when it holds a comma, quote, CR or LF, with quotes doubled.
 * A text cell that a spreadsheet would read as a formula (`=`, `+`, `-`, `@`, tab, CR) is
 * prefixed with `'` — CSV injection (OWASP). Numbers, booleans and dates are written as such.
 */
export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: Cell[]) => `${cells.map(csvCell).join(',')}\r\n`;

/** A page reader: rows of the page and whether another page follows. */
export type PageReader = (page: number) => Promise<{ rows: Cell[][]; more: boolean }>;

export interface BuiltCsv {
  content: Buffer;
  rowCount: number;
  truncated: boolean;
}

/** Reads pages until the source is exhausted or `maxRows` is reached, and writes the CSV. */
export async function buildCsv(columns: string[], read: PageReader, maxRows = MAX_REPORT_ROWS): Promise<BuiltCsv> {
  const parts: string[] = [csvRow(columns)];
  let rowCount = 0;
  let truncated = false;
  for (let page = 1; ; page++) {
    const { rows, more } = await read(page);
    for (const row of rows) {
      if (rowCount >= maxRows) {
        truncated = true;
        break;
      }
      parts.push(csvRow(row));
      rowCount++;
    }
    if (truncated || !more) break;
    if (rowCount >= maxRows) {
      truncated = more;
      break;
    }
  }
  // A UTF-8 byte-order mark so spreadsheet programs read Amharic and other non-ASCII text right.
  return { content: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(parts.join(''), 'utf8')]), rowCount, truncated };
}
