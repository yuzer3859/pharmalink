import { Inject, Injectable } from '@nestjs/common';
import { CodDisputeProps } from '../../../domain/entities/cod-dispute.entity';
import { CodDisputeStatus } from '../../../domain/enums';
import { DeliveryErrors } from '../../../domain/errors';
import {
  COD_COLLECTION_REPOSITORY,
  CodDisputePage,
  CodDisputeSearchCriteria,
  ICodCollectionRepository,
} from '../../../domain/repositories/cod-collection.repository';
import { ManageCodDisputeCommand } from '../../commands/manage-cod-dispute.command';
import { CodReconciliationView, ListCodCollectionsQuery } from '../../queries/list-cod-collections.query';

export const COD_DISPUTE_ADMIN_PORT = Symbol('COD_DISPUTE_ADMIN_PORT');

/**
 * Re-exported so a consumer depends on this one file and not on Module 08's domain layer. The
 * status enum is Module 08's; the consumer may name its values, never add to them. The note bound
 * is the same one Module 08's own `ResolveCodDisputeDto` applies.
 */
export { CodDisputeStatus } from '../../../domain/enums';
export { MAX_CORRECTION_REASON_LENGTH as MAX_COD_DISPUTE_NOTE_LENGTH } from '../../../domain/entities/cod-correction.entity';
export type { CodDisputeProps } from '../../../domain/entities/cod-dispute.entity';
export type {
  CodDisputePage,
  CodDisputeRecord,
  CodDisputeSearchCriteria,
} from '../../../domain/repositories/cod-collection.repository';
export type { CodReconciliationView } from '../../queries/list-cod-collections.query';

/** One dispute with the full finance view of the collection it questions. */
export interface CodDisputeDetailView {
  dispute: CodDisputeProps;
  /**
   * The collection as `ListCodCollectionsQuery.byId` reports it: original figures, remittance,
   * reconciliation, the correction trail, every dispute, and the derived variances. The same
   * projection Module 08's own finance routes return — nothing assembled specially for this port.
   */
  collection: CodReconciliationView;
}

export interface ResolveCodDisputeRequestInput {
  /** Module 01 `users.id` of the operator, from the access token. */
  actorUserId: string;
  disputeId: string;
  /** How it ended, in the operator's own words. Forwarded to Module 08 as given. */
  resolutionNote: string | null;
}

export interface CodDisputeResolutionResult {
  dispute: CodDisputeProps;
  collectionId: string;
  /** What the dispute was before this call — `RESOLVED` when Module 08 replayed a conclusion. */
  previousStatus: CodDisputeStatus;
  /** `true` when this call closed it; `false` when Module 08 replayed the stored conclusion. */
  changed: boolean;
}

/**
 * Module 08's exported contract for **COD dispute administration**, consumed in-process by Module
 * 16 via Nest DI — the inbound-port shape this module already exports as `IDeliveryPricingPort`
 * and Module 01 as `IIdentityAdminPort` (ADR-002).
 *
 * ## Why this port exists
 *
 * Module 08's own finance surface addresses disputes *through their collection*:
 * `/admin/delivery/cod-reconciliation/{collectionId}/disputes/{disputeId}/resolve`. That is the
 * right shape for a desk working one handover, and the wrong one for a control plane that needs
 * "every open dispute, oldest waiting first" without knowing a collection id. This port adds the
 * cross-collection read and a resolve addressed by dispute id, and nothing else.
 *
 * ## What it does not do
 *
 *  - It decides nothing. `resolveDispute` looks up which collection the dispute belongs to and
 *    delegates to `ManageCodDisputeCommand.resolve` — the same `OPEN → RESOLVED` write-once
 *    transition, the same compare-and-set, the same replay-or-refuse on a second resolution, the
 *    same `DELIVERY_COD_DISPUTE_RESOLVED` audit entry, whichever route the request came in on.
 *  - It touches no money. Resolving a dispute writes no amount, no collection status, no
 *    correction, no ledger entry (the aggregate's own rule, unchanged).
 *  - It opens no dispute and records no correction. Both stay on Module 08's per-collection
 *    routes; a control plane that raised its own questions would be a second desk.
 */
export interface ICodDisputeAdminPort {
  listDisputes(criteria: CodDisputeSearchCriteria, page: number, size: number): Promise<CodDisputePage>;

  /** `null` when no dispute has this id. */
  getDispute(disputeId: string): Promise<CodDisputeDetailView | null>;

  /** Delegates to `ManageCodDisputeCommand.resolve`; Module 08's errors propagate unchanged. */
  resolveDispute(input: ResolveCodDisputeRequestInput): Promise<CodDisputeResolutionResult>;
}

/**
 * Implements `ICodDisputeAdminPort` as a facade over Module 08's own repository read, finance
 * query and dispute command. Owns no decision logic.
 */
@Injectable()
export class CodDisputeAdminPortAdapter implements ICodDisputeAdminPort {
  constructor(
    @Inject(COD_COLLECTION_REPOSITORY) private readonly collections: ICodCollectionRepository,
    private readonly finance: ListCodCollectionsQuery,
    private readonly disputes: ManageCodDisputeCommand,
  ) {}

  listDisputes(criteria: CodDisputeSearchCriteria, page: number, size: number): Promise<CodDisputePage> {
    return this.collections.searchDisputes(criteria, page, size);
  }

  async getDispute(disputeId: string): Promise<CodDisputeDetailView | null> {
    const dispute = await this.collections.findDisputeById(disputeId);
    if (!dispute) {
      return null;
    }
    return { dispute, collection: await this.finance.byId(dispute.collectionId) };
  }

  async resolveDispute(input: ResolveCodDisputeRequestInput): Promise<CodDisputeResolutionResult> {
    const stored = await this.collections.findDisputeById(input.disputeId);
    if (!stored) {
      throw DeliveryErrors.codDisputeNotFound(input.disputeId);
    }
    const result = await this.disputes.resolve({
      actorUserId: input.actorUserId,
      collectionId: stored.collectionId,
      disputeId: stored.id,
      resolutionNote: input.resolutionNote,
    });
    return {
      dispute: result.dispute,
      collectionId: stored.collectionId,
      previousStatus: stored.status,
      changed: result.created,
    };
  }
}
