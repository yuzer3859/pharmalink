export interface StockBatchProps {
  id: string;
  listingId: string;
  batchNumber: string;
  quantity: number;
  expiryDate: Date;
  supplier: string | null;
  receivedAt: Date | null;
  createdAt: Date;
}
