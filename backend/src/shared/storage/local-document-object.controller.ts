import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiException } from '../errors/api-exception';
import { ErrorCode } from '../errors/error-codes';
import { Public } from '../rbac/public.decorator';
import { DOCUMENT_STORAGE_PORT, IDocumentStoragePort, MAX_DOCUMENT_BYTES } from './document-storage.port';
import { InMemoryDocumentStorage } from './in-memory-document-storage';

const notFound = () => new ApiException(ErrorCode.NOT_FOUND, 'Not found.');

/**
 * The signed links of `DOCUMENT_STORAGE=memory` (tests and local development). Public: the signed
 * token *is* the authorization, as with an S3 presigned URL. With any other storage every request
 * here is `404`, so the route does nothing in staging (MinIO) or production.
 */
@Controller('storage/local')
@Public()
export class LocalDocumentObjectController {
  constructor(@Inject(DOCUMENT_STORAGE_PORT) private readonly storage: IDocumentStoragePort) {}

  private get local(): InMemoryDocumentStorage {
    if (!(this.storage instanceof InMemoryDocumentStorage)) throw notFound();
    return this.storage;
  }

  @Put(':token')
  @HttpCode(HttpStatus.OK)
  async upload(@Param('token') token: string, @Req() req: Request): Promise<{ stored: true }> {
    const store = this.local;
    const grant = store.verify(token);
    if (!grant || grant.method !== 'PUT') throw new ApiException(ErrorCode.FORBIDDEN, 'The upload link is not valid.');
    if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== grant.contentType) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The content type differs from the one the link was issued for.');
    }
    const content = await readBody(req, Math.min(grant.bytes, MAX_DOCUMENT_BYTES));
    if (content.length !== grant.bytes) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, 'The size differs from the one the link was issued for.');
    }
    store.write(grant, content);
    return { stored: true };
  }

  @Get(':token')
  read(@Param('token') token: string, @Res() res: Response): void {
    const store = this.local;
    const grant = store.verify(token);
    const object = grant && grant.method === 'GET' ? store.read(grant) : null;
    if (!grant || grant.method !== 'GET') throw new ApiException(ErrorCode.FORBIDDEN, 'The link is not valid.');
    if (!object) throw notFound();
    res.setHeader('Content-Type', grant.contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(object.content);
  }
}

/** The raw request body, refusing more than `max` bytes. */
function readBody(req: Request, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.removeAllListeners('data');
        reject(new ApiException(ErrorCode.VALIDATION_ERROR, 'The upload is larger than the link allows.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
