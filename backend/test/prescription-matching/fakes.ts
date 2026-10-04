import { CatalogProductView, ICatalogPort } from '../../src/modules/prescription-matching/application/ports/outbound/catalog.port';
import { IIdentityPort } from '../../src/modules/prescription-matching/application/ports/outbound/identity.port';
import {
  IAvailabilityPort,
  PharmacyAvailabilityCandidate,
} from '../../src/modules/prescription-matching/application/ports/outbound/availability.port';

/**
 * In-memory test doubles for Module 05's cross-module read ports (§2.1) — no
 * `infrastructure/catalog/`, `infrastructure/identity/`, `infrastructure/availability/` adapters
 * exist yet (explicitly "not built by this task" per each port's own doc comment), so these
 * e2e tests fake the boundary the same way `test/support/recording-notification.adapter.ts`
 * fakes Module 01's notification transport — everything on this module's own side of the port
 * (repositories, unit of work, audit, outbox) is real.
 */
export class FakeCatalogPort implements ICatalogPort {
  private readonly products = new Map<string, CatalogProductView>();

  set(product: CatalogProductView): void {
    this.products.set(product.id, product);
  }

  async getProduct(productId: string): Promise<CatalogProductView | null> {
    return this.products.get(productId) ?? null;
  }
}

export class FakeIdentityPort implements IIdentityPort {
  private readonly roles = new Set<string>();

  grant(userId: string, organizationId: string, roleKey: string): void {
    this.roles.add(`${userId}:${organizationId}:${roleKey}`);
  }

  async getUserOrganizationIds(): Promise<string[]> {
    return [];
  }

  async hasRoleAtOrganization(userId: string, organizationId: string, roleKey: string): Promise<boolean> {
    return this.roles.has(`${userId}:${organizationId}:${roleKey}`);
  }
}

export class FakeAvailabilityPort implements IAvailabilityPort {
  private readonly byProduct = new Map<string, PharmacyAvailabilityCandidate[]>();

  setAvailability(catalogProductId: string, rows: PharmacyAvailabilityCandidate[]): void {
    this.byProduct.set(catalogProductId, rows);
  }

  async getAvailability(catalogProductId: string): Promise<PharmacyAvailabilityCandidate[]> {
    return this.byProduct.get(catalogProductId) ?? [];
  }
}
