import type { ReportRecord } from '@/types';
import { simulate, nextId } from './apiClient';
import type { DataScope } from './scope';

const REPORT_TYPES = [
  'Sales Summary', 'Inventory Valuation', 'Prescription Audit', 'Settlement Statement',
  'Controlled Substance Log', 'Staff Activity', 'Order Fulfilment', 'Revenue by Category',
];

const seedReports = (): ReportRecord[] =>
  Array.from({ length: 14 }).map((_, i) => ({
    id: `rep-${i + 1}`,
    name: `${REPORT_TYPES[i % REPORT_TYPES.length]} — ${['Jan', 'Feb', 'Mar', 'Apr'][i % 4]} 2026`,
    type: REPORT_TYPES[i % REPORT_TYPES.length],
    period: `${['Jan', 'Feb', 'Mar', 'Apr'][i % 4]} 2026`,
    status: (['ready', 'ready', 'ready', 'scheduled', 'generating', 'failed'] as const)[i % 6],
    format: (['PDF', 'CSV', 'XLSX'] as const)[i % 3],
    sizeKb: 120 + i * 47,
    generatedAt: new Date(Date.now() - i * 86400000).toISOString(),
    generatedBy: ['System', 'Operations Admin', 'Compliance Officer'][i % 3],
  }));

let store: ReportRecord[] = seedReports();

export const reportsService = {
  list(_scope: DataScope) {
    return simulate([...store].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)));
  },

  templates() {
    return simulate([...REPORT_TYPES]);
  },

  generate(input: { name: string; type: string; period: string; format: ReportRecord['format'] }) {
    const record: ReportRecord = {
      id: nextId('rep'),
      ...input,
      status: 'generating',
      sizeKb: 0,
      generatedAt: new Date().toISOString(),
      generatedBy: 'You',
    };
    store = [record, ...store];
    // Simulate async completion.
    setTimeout(() => {
      store = store.map((r) =>
        r.id === record.id ? { ...r, status: 'ready', sizeKb: 240 } : r,
      );
    }, 1500);
    return simulate(record);
  },
};
