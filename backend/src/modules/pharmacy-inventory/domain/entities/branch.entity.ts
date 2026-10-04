export interface BranchProps {
  id: string;
  pharmacyId: string;
  name: string;
  region: string | null;
  city: string | null;
  subcity: string | null;
  woreda: string | null;
  addressLine: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Branch entity within a Pharmacy aggregate (module-04 §3.2). Framework-free. */
export class Branch {
  private constructor(private props: BranchProps) {}

  static rehydrate(props: BranchProps): Branch {
    return new Branch(props);
  }

  static create(
    id: string,
    input: Omit<BranchProps, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'isActive'>,
    now: Date = new Date(),
  ): Branch {
    return new Branch({ ...input, id, isActive: true, createdAt: now, updatedAt: now, deletedAt: null });
  }

  get id(): string {
    return this.props.id;
  }
  get pharmacyId(): string {
    return this.props.pharmacyId;
  }

  toProps(): Readonly<BranchProps> {
    return { ...this.props };
  }
}
