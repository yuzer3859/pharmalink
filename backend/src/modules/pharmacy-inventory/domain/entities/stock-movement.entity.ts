import { StockMovementRefType, StockMovementType } from '../enums';

export interface StockMovementProps {
  id: string;
  listingId: string;
  batchId: string | null;
  type: StockMovementType;
  quantityDelta: number;
  reason: string | null;
  refType: StockMovementRefType | null;
  refId: string | null;
  actorUserId: string | null;
  createdAt: Date;
}
