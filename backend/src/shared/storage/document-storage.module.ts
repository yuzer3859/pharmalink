import { Global, Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveDocumentStorage } from './document-storage.config';
import { DOCUMENT_STORAGE_PORT, IDocumentStoragePort } from './document-storage.port';
import { InMemoryDocumentStorage } from './in-memory-document-storage';
import { LocalDocumentObjectController } from './local-document-object.controller';
import { S3DocumentStorage, UnavailableDocumentStorage } from './s3-document-storage';

/**
 * Document storage for the whole process (Work 89, backend/docs/document-storage.md), chosen from
 * `DOCUMENT_STORAGE` by `resolveDocumentStorage`. Global, like audit and the outbox.
 */
@Global()
@Module({
  controllers: [LocalDocumentObjectController],
  providers: [
    {
      provide: DOCUMENT_STORAGE_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): IDocumentStoragePort => {
        const settings = resolveDocumentStorage((key) => config.get(key));
        if (settings.kind === 's3' && settings.s3) return new S3DocumentStorage(settings.s3);
        if (settings.kind === 'memory') {
          const base = config.get<string>('DOCUMENT_STORAGE_PUBLIC_BASE_URL') || `http://127.0.0.1:${config.get('PORT') ?? 3000}`;
          return new InMemoryDocumentStorage(base);
        }
        return new UnavailableDocumentStorage();
      },
    },
  ],
  exports: [DOCUMENT_STORAGE_PORT],
})
export class DocumentStorageModule implements OnModuleInit {
  constructor(@Inject(DOCUMENT_STORAGE_PORT) private readonly storage: IDocumentStoragePort) {}

  async onModuleInit(): Promise<void> {
    if (this.storage instanceof S3DocumentStorage) await this.storage.ensureBucket();
  }
}
