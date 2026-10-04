export interface BranchOperatingHourProps {
  id: string;
  branchId: string;
  weekday: number;
  openTime: string | null;
  closeTime: string | null;
  isClosed: boolean;
}
