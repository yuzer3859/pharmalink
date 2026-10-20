import { Inject, Injectable } from '@nestjs/common';
import {
  IReservationStatusReadPort,
  RESERVATION_STATUS_READ_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/reservation-status-read.port';
import { DECLINE_RECOVERY_REPOSITORY, IDeclineRecoveryRepository } from '../../domain/repositories/decline-recovery.repository';
import { DeclineRecoveryPage, DeclineRecoveryState, IDeclineRecoveryReadPort } from '../ports/inbound/decline-recovery-read.port';
import { classifyDeclineOrder, DeclineRecoverySegment } from './decline-recovery.classifier';
import { DeclineCandidateOrder } from '../../domain/repositories/decline-recovery.repository';

/** Classifies candidate orders against Module 04's current reservation state (one batch read per page). */
export async function classifyCandidates(
  orders: DeclineCandidateOrder[],
  reservations: IReservationStatusReadPort,
): Promise<DeclineRecoverySegment[]> {
  const ids = orders.flatMap((o) => o.lines.map((l) => l.reservationId).filter((id): id is string => id !== null));
  const views = await reservations.findReservations(ids);
  const byId = new Map(views.map((v) => [v.reservationId, v]));
  return orders.flatMap((o) => classifyDeclineOrder(o, byId));
}

@Injectable()
export class DeclineRecoveryReadService implements IDeclineRecoveryReadPort {
  constructor(
    @Inject(DECLINE_RECOVERY_REPOSITORY) private readonly candidates: IDeclineRecoveryRepository,
    @Inject(RESERVATION_STATUS_READ_PORT) private readonly reservations: IReservationStatusReadPort,
  ) {}

  async list(filter: { state?: DeclineRecoveryState }, page: number, size: number): Promise<DeclineRecoveryPage> {
    const generatedAt = new Date();
    const { orders, total } = await this.candidates.pageCandidates((page - 1) * size, size);
    const segments = await classifyCandidates(orders, this.reservations);
    const pageCounts: Record<DeclineRecoveryState, number> = { PENDING_CONFIRMATION: 0, CONFIRMATION_FAILED: 0, ORPHANED: 0, RESOLVED: 0 };
    for (const s of segments) pageCounts[s.state] += 1;
    return {
      generatedAt,
      items: filter.state ? segments.filter((s) => s.state === filter.state) : segments,
      pageCounts,
      countsScope: 'CURRENT_PAGE',
      totalOrders: total,
      page,
      size,
    };
  }
}
