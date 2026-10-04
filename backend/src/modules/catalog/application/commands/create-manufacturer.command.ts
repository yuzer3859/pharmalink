import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { Manufacturer } from '../../domain/entities/manufacturer.entity';
import {
  MANUFACTURER_REPOSITORY,
  IManufacturerRepository,
} from '../../domain/repositories/manufacturer.repository';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { ManufacturerView, toManufacturerView } from '../queries/manufacturer-view';

export interface CreateManufacturerInput {
  actorUserId: string;
  name: string;
  country?: string;
}

/**
 * `POST /admin/catalog/manufacturers` (module-03 §8.2). `name` unique — a DB constraint already
 * present — surfaced as the generic `409 CONFLICT` (no catalog-specific dup-manufacturer code
 * needed, §8.2). No outbox event is emitted (no Manufacturer event is defined in §9's
 * "contracts first" event catalog — no consumer exists yet), but the insert and its audit entry
 * still commit atomically in one transaction (ADR-010's audit-in-transaction discipline, applied
 * uniformly across every Catalog mutation regardless of whether it also has an outbox event).
 */
@Injectable()
export class CreateManufacturerCommand {
  constructor(
    @Inject(MANUFACTURER_REPOSITORY) private readonly manufacturers: IManufacturerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: CreateManufacturerInput): Promise<ManufacturerView> {
    const existing = await this.manufacturers.findByName(input.name);
    if (existing) {
      throw ApiException.conflict('A manufacturer with this name already exists.', {
        field: 'name',
      });
    }

    const created = Manufacturer.create(randomUUID(), { name: input.name, country: input.country });

    await this.uow.run(async (tx) => {
      await this.manufacturers.create(created, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'MANUFACTURER_CREATED',
          resourceType: 'Manufacturer',
          resourceId: created.id,
          context: { name: input.name },
        },
        tx,
      );
    });

    return toManufacturerView(created);
  }
}
