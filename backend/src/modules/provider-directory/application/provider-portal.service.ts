import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { narrowToSelectedOrganization } from '../../../shared/http/selected-organization';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  IDENTITY_ORGANIZATION_READ_PORT,
  type IIdentityOrganizationReadPort,
} from '../../identity/application/ports/inbound/identity-organization-read.port';
import { isWithinEthiopia } from '../../profiles/domain/services/geo-bounds';
import { providerProfileChangedEvent } from '../domain/events';
import { ProviderErrors, type ProviderType } from '../domain/provider-rules';
import { ProviderAdminReadService } from './provider-admin-read.service';

/** The organisation roles that run a facility (Work 160). */
export const FACILITY_ADMIN_ROLES = ['HOSPITAL_ADMIN', 'DIAGNOSTIC_CENTER_ADMIN'];

/** module-09 §5.3: lab tests, imaging and screening packages are offered by labs and diagnostic centres. */
const SERVICE_PROVIDER_TYPES: ProviderType[] = ['DIAGNOSTIC_CENTER', 'LAB'];

type Tx = Prisma.TransactionClient;

interface Caller {
  userId: string;
  providerId: string;
  type: ProviderType;
}

/** Drops keys whose value is `undefined`, so a PATCH changes only what it names. */
function given<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** A PATCH may not clear a required field. */
function requireNotNull(input: object, fields: string[]): void {
  for (const field of fields) {
    if ((input as Record<string, unknown>)[field] === null) throw ApiException.validation(`${field} cannot be cleared.`, { field });
  }
}

function checkPosition(lat: number | undefined | null, lng: number | undefined | null): void {
  if (lat === undefined && lng === undefined) return;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw ApiException.validation('A location needs both its latitude and longitude.', { fields: ['lat', 'lng'] });
  }
  if (!isWithinEthiopia(lat, lng)) throw new ApiException(ErrorCode.ADDRESS_OUTSIDE_ETHIOPIA, 'The location must be in Ethiopia.');
}

/**
 * Work 161: a facility's own administration of its directory profile (module-09 §8.2) — the
 * profile, its locations with their opening hours and facilities, its departments, and (labs and
 * diagnostic centres) its service catalogue. The caller's facility is the one their
 * `HOSPITAL_ADMIN` or `DIAGNOSTIC_CENTER_ADMIN` role is in, narrowed by the portal's chosen
 * organisation (Work 155). A suspended provider can be read but not changed. Every change is
 * audited and announced as `provider.provider.profile_changed`, so discovery can refresh.
 */
@Injectable()
export class ProviderPortalService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly organizations: IIdentityOrganizationReadPort,
    private readonly reads: ProviderAdminReadService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** The facilities the caller administers, oldest first. */
  async mine(userId: string) {
    const organizationIds = await this.organizations.organizationIdsWhereUserHolds(userId, FACILITY_ADMIN_ROLES);
    if (organizationIds.length === 0) return [];
    const rows = await this.prisma.healthcareProvider.findMany({
      where: { organizationId: { in: organizationIds }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, organizationId: true, type: true, displayName: true, transactingStatus: true },
    });
    return rows.map((r) => ({ providerId: r.id, organizationId: r.organizationId, type: r.type, displayName: r.displayName, status: r.transactingStatus }));
  }

  async profile(userId: string) {
    const caller = await this.caller(userId);
    return this.reads.get(caller.providerId);
  }

  async updateProfile(userId: string, input: { nameEn?: string; nameAm?: string; description?: string; website?: string; contactPhone?: string; contactEmail?: string }) {
    const caller = await this.writable(userId);
    const data = given(input);
    await this.change(caller, 'PROVIDER_PROFILE_UPDATED', { fields: Object.keys(data) }, (tx) =>
      tx.healthcareProvider.update({ where: { id: caller.providerId }, data }),
    );
    return this.reads.get(caller.providerId);
  }

  // --- Locations ---------------------------------------------------------------------------

  async createLocation(userId: string, input: Omit<Prisma.ProviderLocationUncheckedCreateInput, 'providerId'>) {
    const caller = await this.writable(userId);
    checkPosition(input.lat, input.lng);
    const location = await this.change(caller, 'PROVIDER_LOCATION_ADDED', { name: input.name }, async (tx) => {
      const first = (await tx.providerLocation.count({ where: { providerId: caller.providerId, deletedAt: null } })) === 0;
      const isPrimary = first || input.isPrimary === true;
      if (isPrimary) await tx.providerLocation.updateMany({ where: { providerId: caller.providerId }, data: { isPrimary: false } });
      return tx.providerLocation.create({ data: { ...input, providerId: caller.providerId, isPrimary }, select: { id: true } });
    });
    return { locationId: location.id };
  }

  async updateLocation(userId: string, locationId: string, input: Record<string, unknown>) {
    const caller = await this.writable(userId);
    requireNotNull(input, ['name', 'city', 'lat', 'lng', 'emergencyAvailability', 'isPrimary', 'isActive']);
    const current = await this.location(caller, locationId);
    const data = given(input) as Prisma.ProviderLocationUpdateInput & { lat?: number; lng?: number };
    if (data.lat !== undefined || data.lng !== undefined) checkPosition(data.lat ?? current.lat, data.lng ?? current.lng);
    await this.change(caller, 'PROVIDER_LOCATION_UPDATED', { locationId, fields: Object.keys(data) }, async (tx) => {
      if (data.isPrimary === true) await tx.providerLocation.updateMany({ where: { providerId: caller.providerId }, data: { isPrimary: false } });
      return tx.providerLocation.update({ where: { id: locationId }, data });
    });
    return { locationId };
  }

  async removeLocation(userId: string, locationId: string) {
    const caller = await this.writable(userId);
    await this.location(caller, locationId);
    await this.change(caller, 'PROVIDER_LOCATION_REMOVED', { locationId }, async (tx) => {
      await tx.providerLocation.update({ where: { id: locationId }, data: { deletedAt: new Date(), isActive: false, isPrimary: false } });
      // Services offered only there are offered by the provider's other locations from now on.
      await tx.serviceOffering.updateMany({ where: { locationId }, data: { locationId: null } });
      const next = await tx.providerLocation.findFirst({ where: { providerId: caller.providerId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
      if (next && !(await tx.providerLocation.count({ where: { providerId: caller.providerId, deletedAt: null, isPrimary: true } }))) {
        await tx.providerLocation.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    });
    return { removed: true };
  }

  /** The whole week, replacing what was there. A day not given is shown as unknown. */
  async setHours(userId: string, locationId: string, hours: Array<{ weekday: number; openTime?: string; closeTime?: string; isClosed?: boolean }>) {
    const caller = await this.writable(userId);
    await this.location(caller, locationId);
    const days = new Set<number>();
    for (const h of hours) {
      if (days.has(h.weekday)) throw ApiException.validation('Each day appears once.', { field: 'hours', weekday: h.weekday });
      days.add(h.weekday);
      if (!h.isClosed && (!h.openTime || !h.closeTime)) {
        throw ApiException.validation('An open day needs its opening and closing time.', { field: 'hours', weekday: h.weekday });
      }
      if (!h.isClosed && h.openTime === h.closeTime) {
        throw ApiException.validation('Opening and closing time must differ.', { field: 'hours', weekday: h.weekday });
      }
    }
    await this.change(caller, 'PROVIDER_HOURS_SET', { locationId, days: hours.length }, async (tx) => {
      await tx.locationOperatingHour.deleteMany({ where: { locationId } });
      if (hours.length > 0) {
        await tx.locationOperatingHour.createMany({
          data: hours.map((h) => ({
            locationId,
            weekday: h.weekday,
            isClosed: h.isClosed === true,
            openTime: h.isClosed ? null : (h.openTime ?? null),
            closeTime: h.isClosed ? null : (h.closeTime ?? null),
          })),
        });
      }
    });
    return { locationId, days: hours.length };
  }

  async setFacilities(userId: string, locationId: string, facilities: string[]) {
    const caller = await this.writable(userId);
    await this.location(caller, locationId);
    const names = facilities.map((f) => f.trim()).filter(Boolean);
    await this.change(caller, 'PROVIDER_FACILITIES_SET', { locationId, count: names.length }, async (tx) => {
      await tx.locationFacility.deleteMany({ where: { locationId } });
      if (names.length > 0) await tx.locationFacility.createMany({ data: names.map((facility) => ({ locationId, facility })) });
    });
    return { locationId, facilities: names };
  }

  // --- Departments -------------------------------------------------------------------------

  async createDepartment(userId: string, input: { name: string; specialty?: string; description?: string; contactPhone?: string }) {
    const caller = await this.writable(userId);
    const department = await this.change(caller, 'PROVIDER_DEPARTMENT_ADDED', { name: input.name }, (tx) =>
      tx.department.create({ data: { ...input, name: input.name.trim(), providerId: caller.providerId }, select: { id: true } }),
    );
    return { departmentId: department.id };
  }

  async updateDepartment(userId: string, departmentId: string, input: Record<string, unknown>) {
    const caller = await this.writable(userId);
    requireNotNull(input, ['name', 'isActive']);
    await this.department(caller, departmentId);
    const data = given(input);
    await this.change(caller, 'PROVIDER_DEPARTMENT_UPDATED', { departmentId, fields: Object.keys(data) }, (tx) =>
      tx.department.update({ where: { id: departmentId }, data }),
    );
    return { departmentId };
  }

  /** Departments are closed rather than deleted: doctors are linked to them (Module 10). */
  async closeDepartment(userId: string, departmentId: string) {
    const caller = await this.writable(userId);
    await this.department(caller, departmentId);
    await this.change(caller, 'PROVIDER_DEPARTMENT_CLOSED', { departmentId }, (tx) =>
      tx.department.update({ where: { id: departmentId }, data: { isActive: false } }),
    );
    return { closed: true };
  }

  // --- Services ----------------------------------------------------------------------------

  async createService(userId: string, input: Omit<Prisma.ServiceOfferingUncheckedCreateInput, 'providerId'>) {
    const caller = await this.writable(userId);
    this.assertOffersServices(caller);
    if (input.locationId) await this.location(caller, input.locationId);
    const service = await this.change(caller, 'PROVIDER_SERVICE_ADDED', { name: input.name, type: input.type }, (tx) =>
      tx.serviceOffering.create({ data: { ...input, name: input.name.trim(), providerId: caller.providerId }, select: { id: true } }),
    );
    return { serviceId: service.id };
  }

  async updateService(userId: string, serviceId: string, input: Record<string, unknown>) {
    const caller = await this.writable(userId);
    this.assertOffersServices(caller);
    requireNotNull(input, ['type', 'name', 'isAvailable']);
    await this.service(caller, serviceId);
    if (typeof input.locationId === 'string') await this.location(caller, input.locationId);
    const data = given(input);
    await this.change(caller, 'PROVIDER_SERVICE_UPDATED', { serviceId, fields: Object.keys(data) }, (tx) =>
      tx.serviceOffering.update({ where: { id: serviceId }, data }),
    );
    return { serviceId };
  }

  async removeService(userId: string, serviceId: string) {
    const caller = await this.writable(userId);
    await this.service(caller, serviceId);
    await this.change(caller, 'PROVIDER_SERVICE_REMOVED', { serviceId }, (tx) => tx.serviceOffering.delete({ where: { id: serviceId } }));
    return { removed: true };
  }

  // --- Helpers -----------------------------------------------------------------------------

  private async caller(userId: string): Promise<Caller & { status: string }> {
    const organizationIds = narrowToSelectedOrganization(await this.organizations.organizationIdsWhereUserHolds(userId, FACILITY_ADMIN_ROLES));
    const provider =
      organizationIds.length === 0
        ? null
        : await this.prisma.healthcareProvider.findFirst({
            where: { organizationId: { in: organizationIds }, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true, type: true, transactingStatus: true },
          });
    if (!provider) throw ProviderErrors.notFound();
    return { userId, providerId: provider.id, type: provider.type as ProviderType, status: provider.transactingStatus };
  }

  private async writable(userId: string): Promise<Caller> {
    const caller = await this.caller(userId);
    if (caller.status === 'SUSPENDED') {
      throw new ApiException(ErrorCode.PROVIDER_SUSPENDED, 'This healthcare provider is suspended and cannot be changed.');
    }
    return caller;
  }

  private assertOffersServices(caller: Caller): void {
    if (!SERVICE_PROVIDER_TYPES.includes(caller.type)) {
      throw ApiException.businessRule('Only labs and diagnostic centres list tests, imaging and screening packages.', { code: 'SERVICE_NOT_ALLOWED_FOR_TYPE', type: caller.type });
    }
  }

  private async location(caller: Caller, locationId: string) {
    const row = await this.prisma.providerLocation.findFirst({ where: { id: locationId, providerId: caller.providerId, deletedAt: null } });
    if (!row) throw ApiException.notFound('Location not found.');
    return row;
  }

  private async department(caller: Caller, departmentId: string) {
    const row = await this.prisma.department.findFirst({ where: { id: departmentId, providerId: caller.providerId } });
    if (!row) throw ApiException.notFound('Department not found.');
    return row;
  }

  private async service(caller: Caller, serviceId: string) {
    const row = await this.prisma.serviceOffering.findFirst({ where: { id: serviceId, providerId: caller.providerId } });
    if (!row) throw ApiException.notFound('Service not found.');
    return row;
  }

  /** Runs one change with its audit entry and the `profile_changed` event, in one transaction. */
  private change<T>(caller: Caller, action: string, context: Record<string, unknown>, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await work(tx);
      await this.audit.record({ actorUserId: caller.userId, action, resourceType: 'HealthcareProvider', resourceId: caller.providerId, context }, tx);
      await this.outbox.write(providerProfileChangedEvent({ providerId: caller.providerId, change: action }), tx as never);
      return result;
    });
  }
}
