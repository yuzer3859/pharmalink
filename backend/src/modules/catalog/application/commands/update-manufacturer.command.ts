import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ManufacturerEdits } from '../../domain/entities/manufacturer.entity';
import { CatalogErrors } from '../../domain/errors';
import {
  MANUFACTURER_REPOSITORY,
  IManufacturerRepository,
} from '../../domain/repositories/manufacturer.repository';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { ManufacturerView, toManufacturerView } from '../queries/manufacturer-view';

export interface UpdateManufacturerInput {
  actorUserId: string;
  manufacturerId: string;
  name?: string;
  country?: string;
  status?: string;
}

/** `PATCH /admin/catalog/manufacturers/:id` (module-03 §8.2). */
@Injectable()
export class UpdateManufacturerCommand {
  constructor(
    @Inject(MANUFACTURER_REPOSITORY) private readonly manufacturers: IManufacturerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: UpdateManufacturerInput): Promise<ManufacturerView> {
    const found = await this.manufacturers.findById(input.manufacturerId);
    if (!found) {
      throw CatalogErrors.manufacturerNotFound();
    }

    if (input.name) {
      const existing = await this.manufacturers.findByName(input.name);
      if (existing && existing.id !== found.id) {
        throw ApiException.conflict('A manufacturer with this name already exists.', {
          field: 'name',
        });
      }
    }

    const edits: ManufacturerEdits = { name: input.name, country: input.country, status: input.status };
    const changedFields = found.applyEdits(edits);

    await this.uow.run(async (tx) => {
      await this.manufacturers.save(found, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'MANUFACTURER_UPDATED',
          resourceType: 'Manufacturer',
          resourceId: found.id,
          context: { fields: changedFields },
        },
        tx,
      );
    });

    return toManufacturerView(found);
  }
}
