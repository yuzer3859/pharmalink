import { Inject, Injectable } from '@nestjs/common';
import {
  MANUFACTURER_REPOSITORY,
  IManufacturerRepository,
} from '../../domain/repositories/manufacturer.repository';
import { ManufacturerView, toManufacturerView } from './manufacturer-view';

/** `GET /admin/catalog/manufacturers` (`catalog:manage:any`) — standard admin list, §8.2. */
@Injectable()
export class ListManufacturersQuery {
  constructor(
    @Inject(MANUFACTURER_REPOSITORY) private readonly manufacturers: IManufacturerRepository,
  ) {}

  async execute(): Promise<ManufacturerView[]> {
    const rows = await this.manufacturers.list();
    return rows.map(toManufacturerView);
  }
}
