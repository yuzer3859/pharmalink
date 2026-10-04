import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import {
  COD_DISPUTE_ADMIN_PORT,
  CodDisputeDetailView,
  ICodDisputeAdminPort,
} from '../../../delivery/application/ports/inbound/cod-dispute-admin.port';

/**
 * `GET /admin/cod-disputes/:id` — one dispute with the finance view of the collection it
 * questions: original figures, remittance, reconciliation, the correction trail, every dispute on
 * the same collection, and the derived variances. All of it is Module 08's own projection; this
 * query adds nothing and joins nothing.
 */
@Injectable()
export class GetCodDisputeQuery {
  constructor(@Inject(COD_DISPUTE_ADMIN_PORT) private readonly disputes: ICodDisputeAdminPort) {}

  async execute(disputeId: string): Promise<CodDisputeDetailView> {
    const view = await this.disputes.getDispute(disputeId);
    if (!view) {
      throw ApiException.notFound('COD dispute not found.');
    }
    return view;
  }
}
