import { Inject, Injectable } from '@nestjs/common';
import {
  DRIVER_OPERATIONS_READ_PORT,
  DriverOperationsFilter,
  DriverOperationsPage,
  DriverOperationsSummary,
  IDriverOperationsReadPort,
} from '../../../delivery/application/ports/inbound/driver-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_DRIVER_OPERATIONS_PAGE = 1;
export const DEFAULT_DRIVER_OPERATIONS_PAGE_SIZE = 20;
export const MAX_DRIVER_OPERATIONS_PAGE_SIZE = 100;

export interface ListDriverOperationsInput extends DriverOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/drivers` (module-16 Work 37): Module 08 driver profiles newest first, each
 * with its availability, shift and job counts, through `DRIVER_OPERATIONS_READ_PORT`. Paging clamped
 * to 1..100 (default 20), as every Module 16 list. Every value is Module 08's; nothing is derived
 * here. Read-only; not audited.
 */
@Injectable()
export class ListDriverOperationsQuery {
  constructor(@Inject(DRIVER_OPERATIONS_READ_PORT) private readonly drivers: IDriverOperationsReadPort) {}

  execute(input: ListDriverOperationsInput): Promise<DriverOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_DRIVER_OPERATIONS_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_DRIVER_OPERATIONS_PAGE_SIZE)
        : DEFAULT_DRIVER_OPERATIONS_PAGE_SIZE;
    return this.drivers.listDrivers({ availability: input.availability, onShift: input.onShift }, page, size);
  }
}

/**
 * `GET /admin/operations/drivers/:driverProfileId` (module-16 Work 37): one driver profile's
 * operational summary. Unknown profile → 404. Read-only; not audited.
 */
@Injectable()
export class GetDriverOperationsQuery {
  constructor(@Inject(DRIVER_OPERATIONS_READ_PORT) private readonly drivers: IDriverOperationsReadPort) {}

  async execute(driverProfileId: string): Promise<DriverOperationsSummary> {
    const driver = await this.drivers.getDriver(driverProfileId);
    if (!driver) throw AdminErrors.driverProfileNotFound();
    return driver;
  }
}
