import { Global, Module } from '@nestjs/common';
import { EVENT_BUS, EventBusService } from './event-bus.service';

@Global()
@Module({
  providers: [
    EventBusService,
    { provide: EVENT_BUS, useExisting: EventBusService },
  ],
  exports: [EventBusService, EVENT_BUS],
})
export class EventBusModule {}
