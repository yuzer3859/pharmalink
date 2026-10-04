import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { prescriptionUploadedEvent } from '../../domain/events';
import {
  IPrescriptionRepository,
  PRESCRIPTION_REPOSITORY,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { ValidityPeriod } from '../../domain/value-objects/validity-period';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithMatchRetry } from '../support/match-retry';

export interface UploadPrescriptionInput {
  customerUserId: string;
  beneficiaryId?: string;
  fileRef: string;
  encryptionKeyRef?: string;
  fileType: string;
  doctorName?: string;
  hospitalName?: string;
  issueDate?: Date;
  expiryDate?: Date;
}

/** Config-namespaced default retention period (years) when `prescription.retentionYears` (§20 Q2) is unset. */
const DEFAULT_RETENTION_YEARS = 10;

/**
 * `POST /prescriptions` (module-05 §5.1, §10.1, §12 "Upload prescription"). Business validation
 * (`expiryDate >= issueDate`) is enforced by `ValidityPeriod.of` at the domain boundary, not just
 * DTO shape (§5.1). Single `Serializable` transaction: prescription insert, audit entry, outbox
 * `PrescriptionUploaded` (§2.1.1/§12) — `retentionUntil` is computed once at create time
 * (`now + retentionYears`, §3.1) and never recomputed.
 */
@Injectable()
export class UploadPrescriptionCommand {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: UploadPrescriptionInput): Promise<PrescriptionSnapshot> {
    const validity = ValidityPeriod.of({ issueDate: input.issueDate, expiryDate: input.expiryDate });

    const retentionYears = Number(
      this.config.get<number>('prescription.retentionYears') ?? DEFAULT_RETENTION_YEARS,
    );
    const retentionUntil = new Date();
    retentionUntil.setFullYear(retentionUntil.getFullYear() + retentionYears);

    return runWithMatchRetry(this.uow, async (tx) => {
      const created = await this.prescriptions.create(
        {
          customerUserId: input.customerUserId,
          beneficiaryId: input.beneficiaryId ?? null,
          fileRef: input.fileRef,
          encryptionKeyRef: input.encryptionKeyRef ?? null,
          fileType: input.fileType,
          doctorName: input.doctorName ?? null,
          hospitalName: input.hospitalName ?? null,
          issueDate: validity.issueDate,
          expiryDate: validity.expiryDate,
          retentionUntil,
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.customerUserId,
          action: 'PRESCRIPTION_UPLOADED',
          resourceType: 'Prescription',
          resourceId: created.id,
        },
        tx,
      );

      await this.outbox.write(
        prescriptionUploadedEvent({ prescriptionId: created.id, customerUserId: created.customerUserId }),
        tx as never,
      );

      return created;
    });
  }
}
