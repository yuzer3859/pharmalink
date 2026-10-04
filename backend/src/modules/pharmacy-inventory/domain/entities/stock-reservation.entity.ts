import { ReservationStatus } from '../enums';

export interface StockReservationProps {
  id: string;
  listingId: string;
  orderId: string | null;
  quantity: number;
  status: ReservationStatus;
  expiresAt: Date;
  createdAt: Date;
}
