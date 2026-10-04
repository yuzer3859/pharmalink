import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../../identity/interface/decorators/public.decorator';
import { GetAvailabilityQuery } from '../../application/queries/get-availability.query';
import { GetAvailabilityQueryDto } from '../dtos/availability.dto';

/**
 * `GET /availability/product/:catalogProductId` (module-04 §10.3) — the ONLY HTTP route in
 * this module's availability surface; reserve/confirm/release/dispatch are `IInventoryPort`
 * methods (§14.6), never HTTP. Bare `@Public()` and nothing else.
 */
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly getAvailability: GetAvailabilityQuery) {}

  @Get('product/:catalogProductId')
  @Public()
  get(@Param('catalogProductId') catalogProductId: string, @Query() query: GetAvailabilityQueryDto) {
    return this.getAvailability.execute(catalogProductId, query);
  }
}
