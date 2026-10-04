import { StorageRequirement } from '../enums';

export interface InventoryListingProps {
  id: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  price: number;
  currency: string;
  onHand: number;
  reserved: number;
  sellable: number;
  isEnabled: boolean;
  storageRequirement: StorageRequirement;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** InventoryListing aggregate root (module-04 §3.4). Framework-free. */
export class InventoryListing {
  private constructor(private props: InventoryListingProps) {}

  static rehydrate(props: InventoryListingProps): InventoryListing {
    return new InventoryListing(props);
  }

  static create(
    id: string,
    input: {
      pharmacyId: string;
      branchId: string;
      catalogProductId: string;
      price: number;
      currency: string;
      storageRequirement: StorageRequirement;
    },
    now: Date = new Date(),
  ): InventoryListing {
    return new InventoryListing({
      id,
      pharmacyId: input.pharmacyId,
      branchId: input.branchId,
      catalogProductId: input.catalogProductId,
      price: input.price,
      currency: input.currency,
      onHand: 0,
      reserved: 0,
      sellable: 0,
      isEnabled: true,
      storageRequirement: input.storageRequirement,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  get id(): string {
    return this.props.id;
  }

  toProps(): Readonly<InventoryListingProps> {
    return { ...this.props };
  }
}
