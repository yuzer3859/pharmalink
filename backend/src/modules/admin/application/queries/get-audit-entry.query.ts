import { Inject, Injectable } from '@nestjs/common';
import { computeEntryHash } from '../../../../shared/audit/audit-hash';
import {
  AUDIT_READ_PORT,
  AuditRecordView,
  IAuditReadPort,
} from '../../../../shared/audit/audit-read.port';
import { ApiException } from '../../../../shared/errors/api-exception';

export interface AuditEntryView extends AuditRecordView {
  /**
   * Whether the stored `hash` equals the hash recomputed from the stored fields and `prevHash` —
   * the entry's own link, checked with the project's existing `computeEntryHash`. `false` means
   * the row was altered after it was written. This says nothing about the link *into* this entry
   * from its predecessor; that is chain verification, which is deferred.
   */
  hashValid: boolean;
}

/** `GET /admin/audit/:id` — one entry, with its own-link integrity. Unknown id → 404. */
@Injectable()
export class GetAuditEntryQuery {
  constructor(@Inject(AUDIT_READ_PORT) private readonly audit: IAuditReadPort) {}

  async execute(id: string): Promise<AuditEntryView> {
    const entry = await this.audit.findById(id);
    if (!entry) {
      throw ApiException.notFound('Audit entry not found');
    }
    const recomputed = computeEntryHash(entry.prevHash, {
      actorUserId: entry.actorUserId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      context: entry.context,
      ip: entry.ip,
      createdAt: entry.createdAt.toISOString(),
    });
    return { ...entry, hashValid: recomputed === entry.hash };
  }
}
