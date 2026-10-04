export interface ManufacturerProps {
  id: string;
  name: string;
  country: string | null;
  status: string | null;
  createdAt: Date;
}

export interface NewManufacturerProps {
  name: string;
  country?: string | null;
}

export interface ManufacturerEdits {
  name?: string;
  country?: string | null;
  status?: string;
}

/** Manufacturer reference entity (module-03 §3.3). No hard delete — `status = INACTIVE` instead
 * (§3.6 invariant 7 posture, applied consistently to Manufacturer too). */
export class Manufacturer {
  private constructor(private props: ManufacturerProps) {}

  static rehydrate(props: ManufacturerProps): Manufacturer {
    return new Manufacturer(props);
  }

  static create(id: string, input: NewManufacturerProps, now: Date = new Date()): Manufacturer {
    return new Manufacturer({
      id,
      name: input.name,
      country: input.country ?? null,
      status: 'ACTIVE',
      createdAt: now,
    });
  }

  get id(): string {
    return this.props.id;
  }

  applyEdits(edits: ManufacturerEdits): string[] {
    const changed: string[] = [];
    const next = { ...this.props };

    if (edits.name !== undefined) {
      next.name = edits.name;
      changed.push('name');
    }
    if (edits.country !== undefined) {
      next.country = edits.country;
      changed.push('country');
    }
    if (edits.status !== undefined) {
      next.status = edits.status;
      changed.push('status');
    }

    this.props = next;
    return changed;
  }

  toProps(): Readonly<ManufacturerProps> {
    return { ...this.props };
  }
}
