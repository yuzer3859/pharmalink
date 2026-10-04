import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { ENCRYPTION_PORT } from './crypto.port';

@Global()
@Module({
  providers: [
    CryptoService,
    { provide: ENCRYPTION_PORT, useExisting: CryptoService },
  ],
  exports: [CryptoService, ENCRYPTION_PORT],
})
export class CryptoModule {}
