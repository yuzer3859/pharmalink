import { InMemoryDocumentStorage } from '../../shared/storage/in-memory-document-storage';
import { parseDocumentRef } from '../../shared/storage/document-storage.port';
import { UnavailableDocumentStorage } from '../../shared/storage/s3-document-storage';
import { samplePdf, seedSampleDocument } from './sample-document';

const OWNER = '11111111-1111-4111-8111-111111111111';

describe('staging sample documents (Work 89)', () => {
  it('builds a PDF whose cross-reference offsets point at its objects', () => {
    const pdf = samplePdf('driving licence').toString('latin1');
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf).toContain('not a real document');
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
    expect(pdf.slice(startxref).startsWith('xref\n0 6\n')).toBe(true);
    const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => expect(pdf.slice(o).startsWith(`${i + 1} 0 obj\n`)).toBe(true));
  });

  it('stores the sample and returns a doc: reference, or falls back without storage', async () => {
    const storage = new InMemoryDocumentStorage('http://x');
    const ref = await seedSampleDocument(storage, OWNER, 'licence', 'staging-seed/x.pdf');
    const parsed = parseDocumentRef(ref)!;
    expect(parsed.ownerId).toBe(OWNER);
    expect(await storage.describe(parsed)).toMatchObject({ contentType: 'application/pdf' });
    expect(await seedSampleDocument(new UnavailableDocumentStorage(), OWNER, 'licence', 'staging-seed/x.pdf')).toBe('staging-seed/x.pdf');
    expect(await seedSampleDocument(null, OWNER, 'licence', 'staging-seed/x.pdf')).toBe('staging-seed/x.pdf');
  });
});
