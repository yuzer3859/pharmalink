import { Inject, Injectable } from '@nestjs/common';
import {
  IOrderRepository,
  ListOrdersCriteria,
  ORDER_REPOSITORY,
  OrderSnapshot,
  PagedResult,
} from '../../domain/repositories/order.repository';

/**
 * `GET /orders` (module-06 `06-orders-spec.md` §9.3, BR-ORD-07) — paginated, customer-scoped,
 * optionally filtered by `status`. `criteria.customerUserId` must come from the authenticated
 * caller, never a client-supplied field (Step 7) — this query performs no ownership
 * post-filtering of its own because `IOrderRepository.listByCustomer` is already scoped by it.
 */
@Injectable()
export class ListOrdersQuery {
  constructor(@Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository) {}

  execute(criteria: ListOrdersCriteria): Promise<PagedResult<OrderSnapshot>> {
    return this.orders.listByCustomer(criteria);
  }
}
