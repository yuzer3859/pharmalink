import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  IDENTITY_ORGANIZATION_READ_PORT,
  type IIdentityOrganizationReadPort,
} from '../../identity/application/ports/inbound/identity-organization-read.port';
import { PROVIDER_FACILITY_PORT, type IProviderFacilityPort } from '../../provider-directory/application/ports/inbound/provider-facility.port';
import { doctorEvent, DoctorErrors, DoctorEventType, isDoctorListed, type DoctorStatus } from '../domain/doctor-rules';
import type {
  DoctorAffiliationView,
  DoctorListItem,
  DoctorRecord,
  IDoctorAdminPort,
  RegisterDoctorProfileInput,
} from './ports/inbound/doctor-admin.port';

type Row = Prisma.DoctorProfileGetPayload<{ include: { affiliations: true } }>;
type Tx = Prisma.TransactionClient;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** ILIKE with the user's text taken literally. */
const contains = (q: string): Prisma.StringFilter => ({ contains: q.replace(/[\\%_]/g, (c) => `\\${c}`), mode: 'insensitive' });

export interface DoctorProfileUpdate {
  fullNameAm?: string;
  subSpecialties?: string[];
  qualifications?: string[];
  yearsExperience?: number;
  bio?: string;
  languages?: string[];
  consultationFeeInPerson?: number;
  consultationFeeTele?: number;
  acceptsTelemedicine?: boolean;
}

/**
 * Work 166: doctors as bookable professionals (module-10 §3.1). A doctor is a Module 01 account
 * with role DOCTOR, registered by a platform administrator on an approved medical licence; this
 * module owns their professional profile and where they practise. A doctor appears to patients
 * only while ACTIVE, verified and on a current licence. Facilities add the doctors who practise
 * with them (optionally in a department); the doctor edits their own professional details; the
 * name and specialty are set at registration. Every change is audited and announced on the
 * outbox (`doctor.doctor.*`) in the same transaction.
 */
@Injectable()
export class DoctorService implements IDoctorAdminPort {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDER_FACILITY_PORT) private readonly facilities: IProviderFacilityPort,
    @Inject(IDENTITY_ORGANIZATION_READ_PORT) private readonly accounts: IIdentityOrganizationReadPort,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // --- Platform administrator --------------------------------------------------------------

  async findByUser(userId: string) {
    const row = await this.prisma.doctorProfile.findFirst({ where: { userId, deletedAt: null }, select: { id: true } });
    return row ? { doctorId: row.id } : null;
  }

  async createProfile(input: RegisterDoctorProfileInput): Promise<{ doctorId: string }> {
    const existing = await this.findByUser(input.userId);
    if (existing) return existing;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.doctorProfile.create({
          data: {
            userId: input.userId,
            fullName: input.fullName.trim(),
            fullNameAm: input.fullNameAm?.trim() || null,
            specialty: input.specialty.trim(),
            licenseNumber: input.licenseNumber.trim(),
            licenseExpiresAt: input.licenseExpiresAt,
            isVerified: true,
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        await this.record(tx, input.actorUserId, 'DOCTOR_PROFILE_CREATED', row.id, { userId: input.userId, specialty: input.specialty.trim() });
        await this.outbox.write(doctorEvent(DoctorEventType.DoctorActivated, { doctorId: row.id }), tx as never);
        return { doctorId: row.id };
      });
    } catch (err) {
      const winner = await this.findByUser(input.userId);
      if (winner) return winner;
      throw err;
    }
  }

  async list(filter: { q?: string; specialty?: string; status?: DoctorStatus }, page: number, size: number) {
    const q = filter.q?.trim();
    const where: Prisma.DoctorProfileWhereInput = {
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.specialty?.trim() ? { specialty: { equals: filter.specialty.trim(), mode: 'insensitive' } } : {}),
      ...(q ? { OR: [{ fullName: contains(q) }, { fullNameAm: contains(q) }, { specialty: contains(q) }, { licenseNumber: contains(q) }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.doctorProfile.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * size, take: size }),
      this.prisma.doctorProfile.count({ where }),
    ]);
    return { items: rows.map((r) => this.listItem(r)), total };
  }

  async get(doctorId: string): Promise<DoctorRecord | null> {
    const row = await this.prisma.doctorProfile.findFirst({ where: { id: doctorId, deletedAt: null }, include: { affiliations: true } });
    return row ? this.toRecord(row) : null;
  }

  async suspend(input: { actorUserId: string; doctorId: string; reason: string }): Promise<boolean> {
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3 || reason.length > 500) throw DoctorErrors.reasonRequired();
    const row = await this.mustFind(input.doctorId);
    if (row.status === 'SUSPENDED') return false;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.doctorProfile.updateMany({ where: { id: row.id, status: 'ACTIVE' }, data: { status: 'SUSPENDED' } });
      if (updated.count !== 1) return false;
      await this.record(tx, input.actorUserId, 'DOCTOR_SUSPENDED', row.id, { reason });
      await this.outbox.write(doctorEvent(DoctorEventType.DoctorSuspended, { doctorId: row.id, reason: 'MANUAL' }), tx as never);
      return true;
    });
  }

  async reactivate(input: { actorUserId: string; doctorId: string }): Promise<boolean> {
    const row = await this.mustFind(input.doctorId);
    if (row.status === 'ACTIVE' && row.isVerified) return false;
    if (!row.licenseExpiresAt || row.licenseExpiresAt.getTime() <= Date.now()) throw DoctorErrors.notListed('LICENSE_EXPIRED');
    return this.prisma.$transaction(async (tx) => {
      await tx.doctorProfile.update({ where: { id: row.id }, data: { status: 'ACTIVE', isVerified: true } });
      await this.record(tx, input.actorUserId, 'DOCTOR_REACTIVATED', row.id, {});
      await this.outbox.write(doctorEvent(DoctorEventType.DoctorActivated, { doctorId: row.id }), tx as never);
      return true;
    });
  }

  /** Module 01 expired the doctor's licence (and suspended the account): they leave the directory. */
  async licenceExpired(userId: string): Promise<boolean> {
    const row = await this.prisma.doctorProfile.findFirst({ where: { userId, deletedAt: null } });
    if (!row || (row.status === 'SUSPENDED' && !row.isVerified)) return false;
    await this.prisma.$transaction(async (tx) => {
      await tx.doctorProfile.update({ where: { id: row.id }, data: { status: 'SUSPENDED', isVerified: false } });
      await this.record(tx, null, 'DOCTOR_AUTO_SUSPENDED', row.id, { reason: 'LICENSE_EXPIRED' });
      await this.outbox.write(doctorEvent(DoctorEventType.DoctorSuspended, { doctorId: row.id, reason: 'LICENSE_EXPIRED' }), tx as never);
    });
    return true;
  }

  // --- The doctor ---------------------------------------------------------------------------

  async ownProfile(userId: string): Promise<DoctorRecord> {
    const row = await this.prisma.doctorProfile.findFirst({ where: { userId, deletedAt: null }, include: { affiliations: true } });
    if (!row) throw DoctorErrors.notFound();
    return this.toRecord(row);
  }

  async updateOwnProfile(userId: string, input: DoctorProfileUpdate): Promise<DoctorRecord> {
    const row = await this.prisma.doctorProfile.findFirst({ where: { userId, deletedAt: null } });
    if (!row) throw DoctorErrors.notFound();
    const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Prisma.DoctorProfileUpdateInput;
    if (input.qualifications) data.qualifications = input.qualifications as unknown as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.doctorProfile.update({ where: { id: row.id }, data });
      await this.record(tx, userId, 'DOCTOR_PROFILE_UPDATED', row.id, { fields: Object.keys(data) });
      await this.outbox.write(doctorEvent(DoctorEventType.DoctorProfileChanged, { doctorId: row.id, reason: 'DOCTOR_PROFILE_UPDATED' }), tx as never);
    });
    return this.ownProfile(userId);
  }

  // --- A facility's doctors -----------------------------------------------------------------

  async facilityDoctors(userId: string) {
    const facility = await this.callerFacility(userId);
    const rows = await this.prisma.doctorAffiliation.findMany({ where: { providerId: facility.providerId }, include: { doctor: true }, orderBy: { createdAt: 'asc' } });
    const departments = new Map<string, string>();
    for (const r of rows) {
      if (r.departmentId && !departments.has(r.departmentId)) {
        const d = await this.facilities.departmentOf(facility.providerId, r.departmentId);
        if (d) departments.set(d.departmentId, d.name);
      }
    }
    return rows
      .filter((r) => !r.doctor.deletedAt)
      .map((r) => ({
        doctorId: r.doctorId,
        fullName: r.doctor.fullName,
        specialty: r.doctor.specialty,
        status: r.doctor.status,
        listed: isDoctorListed(r.doctor),
        departmentId: r.departmentId,
        departmentName: r.departmentId ? (departments.get(r.departmentId) ?? null) : null,
        roleTitle: r.roleTitle,
        since: r.createdAt,
      }));
  }

  /** A facility adds a doctor who practises with it, found by their sign-in e-mail or phone. */
  async addFacilityDoctor(userId: string, input: { identifier: string; departmentId?: string; roleTitle?: string }) {
    const facility = await this.callerFacility(userId);
    if (facility.status === 'SUSPENDED') {
      throw new ApiException(ErrorCode.PROVIDER_SUSPENDED, 'This healthcare provider is suspended and cannot be changed.');
    }
    const account = await this.accounts.findAccount(input.identifier);
    const doctor = account ? await this.prisma.doctorProfile.findFirst({ where: { userId: account.userId, deletedAt: null } }) : null;
    if (!doctor) throw ApiException.notFound('No registered doctor uses this e-mail or phone. PharmaLink registers doctors first.');
    const department = input.departmentId ? await this.facilities.departmentOf(facility.providerId, input.departmentId) : null;
    if (input.departmentId && !department) throw ApiException.notFound('Department not found.');

    await this.prisma.$transaction(async (tx) => {
      const isFirst = (await tx.doctorAffiliation.count({ where: { doctorId: doctor.id } })) === 0;
      await tx.doctorAffiliation.upsert({
        where: { doctorId_providerId: { doctorId: doctor.id, providerId: facility.providerId } },
        create: { doctorId: doctor.id, providerId: facility.providerId, departmentId: department?.departmentId ?? null, roleTitle: input.roleTitle?.trim() || null, isPrimary: isFirst },
        update: { departmentId: department?.departmentId ?? null, roleTitle: input.roleTitle?.trim() || null },
      });
      await tx.departmentDoctor.deleteMany({ where: { doctorId: doctor.id, department: { providerId: facility.providerId } } });
      if (department) await tx.departmentDoctor.create({ data: { departmentId: department.departmentId, doctorId: doctor.id } });
      await this.record(tx, userId, 'DOCTOR_AFFILIATED', doctor.id, { providerId: facility.providerId, departmentId: department?.departmentId ?? null });
      await this.outbox.write(doctorEvent(DoctorEventType.DoctorProfileChanged, { doctorId: doctor.id, reason: 'DOCTOR_AFFILIATED' }), tx as never);
    });
    return { doctorId: doctor.id, providerId: facility.providerId };
  }

  async removeFacilityDoctor(userId: string, doctorId: string) {
    const facility = await this.callerFacility(userId);
    const link = await this.prisma.doctorAffiliation.findUnique({ where: { doctorId_providerId: { doctorId, providerId: facility.providerId } } });
    if (!link) throw ApiException.notFound('This doctor does not practise at your facility.');
    await this.prisma.$transaction(async (tx) => {
      await tx.doctorAffiliation.delete({ where: { id: link.id } });
      await tx.departmentDoctor.deleteMany({ where: { doctorId, department: { providerId: facility.providerId } } });
      if (link.isPrimary) {
        const next = await tx.doctorAffiliation.findFirst({ where: { doctorId }, orderBy: { createdAt: 'asc' } });
        if (next) await tx.doctorAffiliation.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
      await this.record(tx, userId, 'DOCTOR_UNAFFILIATED', doctorId, { providerId: facility.providerId });
      await this.outbox.write(doctorEvent(DoctorEventType.DoctorProfileChanged, { doctorId, reason: 'DOCTOR_UNAFFILIATED' }), tx as never);
    });
    return { removed: true };
  }

  // --- Patients -----------------------------------------------------------------------------

  /** A listed doctor's public profile; 404 otherwise. Only eligible facilities are shown. */
  async publicProfile(doctorId: string) {
    const row = await this.prisma.doctorProfile.findFirst({ where: { id: doctorId, deletedAt: null }, include: { affiliations: true } });
    if (!row || !isDoctorListed(row)) throw DoctorErrors.notFound();
    const record = await this.toRecord(row);
    return {
      doctorId: record.doctorId,
      fullName: record.fullName,
      fullNameAm: record.fullNameAm,
      specialty: record.specialty,
      subSpecialties: record.subSpecialties,
      qualifications: record.qualifications,
      yearsExperience: record.yearsExperience,
      bio: record.bio,
      languages: record.languages,
      consultationFeeInPerson: record.consultationFeeInPerson,
      consultationFeeTele: record.consultationFeeTele,
      currency: record.currency,
      acceptsTelemedicine: record.acceptsTelemedicine,
      ratingAvg: record.ratingAvg,
      ratingCount: record.ratingCount,
      affiliations: record.affiliations,
    };
  }

  /** The listed doctors practising at an eligible facility (FR-HOSP-08). */
  async providerDoctors(providerId: string) {
    const [facility] = await this.facilities.summaries([providerId]);
    if (!facility?.eligible) throw new ApiException(ErrorCode.PROVIDER_NOT_FOUND, 'Healthcare provider not found.');
    const rows = await this.prisma.doctorAffiliation.findMany({ where: { providerId }, include: { doctor: true }, orderBy: { createdAt: 'asc' } });
    return rows
      .filter((r) => isDoctorListed(r.doctor))
      .map((r) => ({ doctorId: r.doctorId, fullName: r.doctor.fullName, fullNameAm: r.doctor.fullNameAm, specialty: r.doctor.specialty, departmentId: r.departmentId, roleTitle: r.roleTitle }));
  }

  // --- Helpers ------------------------------------------------------------------------------

  private async callerFacility(userId: string) {
    const facility = await this.facilities.callerFacility(userId);
    if (!facility) throw new ApiException(ErrorCode.PROVIDER_NOT_FOUND, 'Healthcare provider not found.');
    return facility;
  }

  private async mustFind(doctorId: string) {
    const row = await this.prisma.doctorProfile.findFirst({ where: { id: doctorId, deletedAt: null } });
    if (!row) throw DoctorErrors.notFound();
    return row;
  }

  private listItem(r: Row | Omit<Row, 'affiliations'>): DoctorListItem {
    return {
      doctorId: r.id,
      userId: r.userId,
      fullName: r.fullName,
      specialty: r.specialty,
      status: r.status as DoctorStatus,
      isVerified: r.isVerified,
      licenseNumber: r.licenseNumber,
      licenseExpiresAt: r.licenseExpiresAt,
      createdAt: r.createdAt,
    };
  }

  private async toRecord(r: Row): Promise<DoctorRecord> {
    const providers = await this.facilities.summaries([...new Set(r.affiliations.map((a) => a.providerId))]);
    const affiliations: DoctorAffiliationView[] = [];
    for (const a of [...r.affiliations].sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary) || x.createdAt.getTime() - y.createdAt.getTime())) {
      const provider = providers.find((p) => p.providerId === a.providerId);
      if (!provider) continue;
      const department = a.departmentId ? await this.facilities.departmentOf(a.providerId, a.departmentId) : null;
      affiliations.push({
        providerId: a.providerId,
        providerName: provider.displayName,
        providerType: provider.type,
        departmentId: department?.departmentId ?? null,
        departmentName: department?.name ?? null,
        roleTitle: a.roleTitle,
        isPrimary: a.isPrimary,
      });
    }
    return {
      ...this.listItem(r),
      fullNameAm: r.fullNameAm,
      subSpecialties: r.subSpecialties,
      qualifications: strings(r.qualifications),
      yearsExperience: r.yearsExperience,
      bio: r.bio,
      languages: r.languages,
      consultationFeeInPerson: r.consultationFeeInPerson,
      consultationFeeTele: r.consultationFeeTele,
      currency: r.currency,
      acceptsTelemedicine: r.acceptsTelemedicine,
      ratingAvg: r.ratingAvg,
      ratingCount: r.ratingCount,
      affiliations,
    };
  }

  private record(tx: Tx, actorUserId: string | null, action: string, doctorId: string, context: Record<string, unknown>) {
    return this.audit.record({ actorUserId, action, resourceType: 'DoctorProfile', resourceId: doctorId, context }, tx);
  }
}
