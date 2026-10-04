import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { OutboxRelay } from './outbox-relay.service';

@Global()
@Module({
  providers: [OutboxService, OutboxRelay],
  exports: [OutboxService, OutboxRelay],
})
export class OutboxModule {}
