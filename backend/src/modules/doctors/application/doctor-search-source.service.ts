import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { DoctorService } from './doctor.service';
import { AvailabilityService } from './availability.service';
import type { DoctorSearchSource, IDoctorSearchSourcePort } from './ports/inbound/doctor-search-source.port';
import { isDoctorListed } from '../domain/doctor-rules';
import { PROVIDER_FACILITY_PORT, type IProviderFacilityPort } from '../../provider-directory/application/ports/inbound/provider-facility.port';

/** Work 167: `IDoctorSearchSourcePort` over Module 10's own tables and Module 09's facility read. */
@Injectable()
export class DoctorSearchSourceService implements IDoctorSearchSourcePort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly doctors: DoctorService,
    private readonly availability: AvailabilityService,
    @Inject(PROVIDER_FACILITY_PORT) private readonly facilities: IProviderFacilityPort,
  ) {}

  async doctorIds(): Promise<string[]> {
    return (await this.prisma.doctorProfile.findMany({ where: { deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } })).map((d) => d.id);
  }

  async doctorIdsAt(providerId: string): Promise<string[]> {
    return (await this.prisma.doctorAffiliation.findMany({ where: { providerId }, select: { doctorId: true } })).map((a) => a.doctorId);
  }

  async doctor(doctorId: string): Promise<DoctorSearchSource | null> {
    const row = await this.prisma.doctorProfile.findFirst({ where: { id: doctorId, deletedAt: null } });
    if (!row) return null;
    const record = await this.doctors.get(doctorId);
    if (!record) return null;
    const facilities = await this.facilities.summaries(record.affiliations.map((a) => a.providerId));
    const practices = record.affiliations
      .map((a) => ({ a, f: facilities.find((f) => f.providerId === a.providerId) }))
      .filter((x) => x.f?.eligible)
      .map(({ a, f }) => ({ providerId: a.providerId, providerName: a.providerName, departmentName: a.departmentName, city: f?.city ?? null, lat: f?.lat ?? null, lng: f?.lng ?? null }));
    return {
      doctorId,
      listed: isDoctorListed(row),
      fullName: record.fullName,
      fullNameAm: record.fullNameAm,
      specialty: record.specialty,
      subSpecialties: record.subSpecialties,
      languages: record.languages,
      consultationFeeInPerson: record.consultationFeeInPerson,
      consultationFeeTele: record.consultationFeeTele,
      currency: record.currency,
      acceptsTelemedicine: record.acceptsTelemedicine,
      ratingAvg: record.ratingAvg,
      ratingCount: record.ratingCount,
      practices,
      nextAvailableAt: await this.availability.nextOpen(doctorId),
    };
  }
}
