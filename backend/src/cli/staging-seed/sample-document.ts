import { randomUUID } from 'crypto';
import { documentRef, IDocumentStoragePort, parseDocumentRef } from '../../shared/storage/document-storage.port';

/**
 * A one-page PDF that says what it is: a staging sample, not a real document (Work 89). Built by
 * hand so the seed needs no PDF library; the cross-reference offsets are computed, so viewers
 * open it without repair.
 */
export function samplePdf(title: string): Buffer {
  const text = `PharmaLink staging sample - ${title} - not a real document`.replace(/[()\\]/g, '');
  const stream = `BT /F1 14 Tf 56 760 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * Stores a sample PDF for `ownerId` and returns its `doc:` reference, so the review can preview
 * it. Without document storage (none configured) it falls back to the text-only reference the
 * seed used before Work 89, which the review shows as not previewable.
 */
export async function seedSampleDocument(storage: IDocumentStoragePort | null, ownerId: string, title: string, fallbackRef: string): Promise<string> {
  if (!storage?.available) return fallbackRef;
  const ref = documentRef('verification', ownerId, randomUUID());
  await storage.put(parseDocumentRef(ref)!, 'application/pdf', samplePdf(title));
  return ref;
}
