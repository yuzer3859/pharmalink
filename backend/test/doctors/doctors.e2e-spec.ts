import request from 'supertest';
import { randomUUID } from 'crypto';
import { ExpireVerificationsCommand } from '../../src/modules/identity/application/commands/expire-verifications.command';
import { auth, body, createUserWithRole, errorOf, login } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { registeredProvider, signedUpAccount } from '../provider-directory/support';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink test medical licence\n%%EOF\n');
const DAY = 24 * 60 * 60 * 1000;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

/**
 * Work 166: Module 10 begins with doctors. The Super Admin registers a doctor on an approved
 * medical licence; the doctor edits their professional profile; facilities name the doctors who
 * practise with them; patients see listed doctors; Disable, Enable and an expired licence hide
 * a doctor.
 */
describe('Doctors — registration, profiles and where they practise (Work 166, e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const as = (token: string) => ({
    get: (path: string) => request(ctx.server).get(path).set(...auth(token)),
    post: (path: string, payload: object = {}) => request(ctx.server).post(path).set(...auth(token)).send(payload),
    patch: (path: string, payload: object) => request(ctx.server).patch(path).set(...auth(token)).send(payload),
    del: (path: string) => request(ctx.server).delete(path).set(...auth(token)),
  });

  async function licenceFile(token: string, userId: string): Promise<string> {
    const issued = body(await as(token).post('/admin/doctor-registrations/uploads', { userId, contentType: 'application/pdf', bytes: PDF.length }).expect(201)) as {
      storageRef: string;
      upload: { url: string };
    };
    await request(ctx.server).put(new URL(issued.upload.url).pathname).set('Content-Type', 'application/pdf').send(PDF).expect(200);
    return issued.storageRef;
  }

  async function registeredDoctor(admin?: { accessToken: string; userId: string }) {
    const platformAdmin = admin ?? (await createUserWithRole(ctx, 'ADMIN'));
    const person = await signedUpAccount(ctx, 'doctor');
    const storageRef = await licenceFile(platformAdmin.accessToken, person.userId);
    const res = await as(platformAdmin.accessToken).post('/admin/doctor-registrations', {
      userId: person.userId,
      fullName: 'Dr. Selamawit Bekele',
      specialty: 'Cardiology',
      licenseNumber: 'EMA/MD/2026/0166',
      licenseExpiresOn: day(365),
      documents: [{ kind: 'MEDICAL_LICENSE', storageRef }],
    });
    expect(res.status).toBe(201);
    const { doctorId } = body(res) as { doctorId: string };
    const tokens = await login(ctx, person.email);
    return { doctorId, person, platformAdmin, token: tokens.accessToken };
  }

  it('registers a doctor on an approved licence; the doctor edits their profile; patients see it', async () => {
    const d = await registeredDoctor();
    const admin = as(d.platformAdmin.accessToken);

    const record = body(await admin.get(`/admin/doctors/${d.doctorId}`).expect(200));
    expect(record).toEqual(
      expect.objectContaining({
        doctorId: d.doctorId,
        userId: d.person.userId,
        fullName: 'Dr. Selamawit Bekele',
        specialty: 'Cardiology',
        status: 'ACTIVE',
        isVerified: true,
        licenseNumber: 'EMA/MD/2026/0166',
        affiliations: [],
        account: expect.objectContaining({ email: d.person.email, status: 'ACTIVE' }),
      }),
    );
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: d.person.userId } })).primaryRole).toBe('DOCTOR');
    const licence = await ctx.prisma.verificationRequest.findFirstOrThrow({ where: { userId: d.person.userId, type: 'DOCTOR_LICENSE' } });
    expect(licence).toMatchObject({ status: 'APPROVED', reviewerId: d.platformAdmin.userId });
    expect((body(await admin.get('/admin/doctors?q=selam').expect(200)).items as unknown[]).length).toBe(1);
    expect((body(await admin.get('/admin/doctors?specialty=dermatology').expect(200)).items as unknown[]).length).toBe(0);

    const me = as(d.token);
    expect(body(await me.get('/doctor/profile').expect(200))).toMatchObject({ doctorId: d.doctorId, fullName: 'Dr. Selamawit Bekele' });
    const updated = body(
      await me
        .patch('/doctor/profile', { bio: 'Adult cardiologist.', languages: ['Amharic', 'English'], consultationFeeInPerson: 50000, acceptsTelemedicine: true, qualifications: ['MD, Addis Ababa University'] })
        .expect(200),
    );
    expect(updated).toMatchObject({ bio: 'Adult cardiologist.', languages: ['Amharic', 'English'], consultationFeeInPerson: 50000, acceptsTelemedicine: true, qualifications: ['MD, Addis Ababa University'] });
    await me.patch('/doctor/profile', { fullName: 'Someone else' }).expect(400);
    await me.patch('/doctor/profile', { consultationFeeInPerson: -1 }).expect(400);

    const publicPage = body(await request(ctx.server).get(`/doctors/${d.doctorId}`).expect(200));
    expect(publicPage).toMatchObject({ doctorId: d.doctorId, fullName: 'Dr. Selamawit Bekele', bio: 'Adult cardiologist.', consultationFeeInPerson: 50000 });
    expect(publicPage).not.toHaveProperty('licenseNumber');
    expect(publicPage).not.toHaveProperty('userId');

    expect(await ctx.prisma.auditLog.count({ where: { action: 'DOCTOR_REGISTERED_BY_ADMIN', resourceId: d.doctorId } })).toBe(1);
    expect(await ctx.prisma.outbox.count({ where: { aggregateId: d.doctorId, eventType: { in: ['doctor.doctor.activated', 'doctor.doctor.profile_changed'] } } })).toBe(2);

    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await as(customer.accessToken).get('/doctor/profile').expect(403);
  });

  it('a facility names the doctors who practise with it, in a department', async () => {
    const d = await registeredDoctor();
    const p = await registeredProvider(ctx, { admin: d.platformAdmin });
    const facility = as(p.token);
    const cardiology = body(await facility.post('/provider/departments', { name: 'Cardiology', specialty: 'Cardiology' }).expect(201)).departmentId as string;

    await facility.post('/provider/doctors', { identifier: 'nobody@pharmalink.test' }).expect(404);
    await facility.post('/provider/doctors', { identifier: d.person.email, departmentId: randomUUID() }).expect(404);
    await facility.post('/provider/doctors', { identifier: d.person.email.toUpperCase(), departmentId: cardiology, roleTitle: 'Consultant' }).expect(201);

    expect(body(await facility.get('/provider/doctors').expect(200)).items).toEqual([
      expect.objectContaining({ doctorId: d.doctorId, fullName: 'Dr. Selamawit Bekele', listed: true, departmentId: cardiology, departmentName: 'Cardiology', roleTitle: 'Consultant' }),
    ]);
    expect(body(await request(ctx.server).get(`/providers/${p.providerId}/doctors`).expect(200)).items).toEqual([
      expect.objectContaining({ doctorId: d.doctorId, specialty: 'Cardiology', departmentId: cardiology }),
    ]);
    expect(body(await request(ctx.server).get(`/doctors/${d.doctorId}`).expect(200)).affiliations).toEqual([
      expect.objectContaining({ providerId: p.providerId, providerName: 'Tikur Anbessa Hospital', providerType: 'HOSPITAL', departmentName: 'Cardiology', roleTitle: 'Consultant', isPrimary: true }),
    ]);
    expect(await ctx.prisma.departmentDoctor.count({ where: { doctorId: d.doctorId } })).toBe(1);

    expect(body(await facility.del(`/provider/doctors/${d.doctorId}`).expect(200))).toEqual({ removed: true });
    expect(body(await facility.get('/provider/doctors').expect(200)).items).toEqual([]);
    expect(await ctx.prisma.departmentDoctor.count({ where: { doctorId: d.doctorId } })).toBe(0);
    await facility.del(`/provider/doctors/${d.doctorId}`).expect(404);
  });

  it('Disable hides the doctor and signs them out; Enable needs a current licence', async () => {
    const d = await registeredDoctor();
    const admin = as(d.platformAdmin.accessToken);
    await admin.post(`/admin/doctors/${d.doctorId}/suspend`, { reason: 'no' }).expect(400);
    expect(body(await admin.post(`/admin/doctors/${d.doctorId}/suspend`, { reason: 'Complaint under review' }).expect(200))).toEqual({ suspended: true });
    await request(ctx.server).get(`/doctors/${d.doctorId}`).expect(404);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: d.person.userId } })).status).toBe('SUSPENDED');

    expect(body(await admin.post(`/admin/doctors/${d.doctorId}/reactivate`).expect(200))).toEqual({ reactivated: true });
    await request(ctx.server).get(`/doctors/${d.doctorId}`).expect(200);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: d.person.userId } })).status).toBe('ACTIVE');

    await admin.post(`/admin/doctors/${d.doctorId}/suspend`, { reason: 'Licence check' }).expect(200);
    await ctx.prisma.doctorProfile.update({ where: { id: d.doctorId }, data: { licenseExpiresAt: new Date(Date.now() - DAY) } });
    const refused = await admin.post(`/admin/doctors/${d.doctorId}/reactivate`);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe('DOCTOR_NOT_VERIFIED');
  });

  it('an expired medical licence takes the doctor out of the directory', async () => {
    const d = await registeredDoctor();
    await ctx.prisma.verificationRequest.updateMany({ where: { userId: d.person.userId, type: 'DOCTOR_LICENSE' }, data: { expiresAt: new Date(Date.now() - DAY) } });
    await ctx.app.get(ExpireVerificationsCommand).execute(new Date());
    await ctx.drainOutbox();
    expect(await ctx.prisma.doctorProfile.findUniqueOrThrow({ where: { id: d.doctorId } })).toMatchObject({ status: 'SUSPENDED', isVerified: false });
    await request(ctx.server).get(`/doctors/${d.doctorId}`).expect(404);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'DOCTOR_AUTO_SUSPENDED', resourceId: d.doctorId } })).toBe(1);
  });

  it('refuses an expired licence, an account that is not a customer, and anyone without the permission', async () => {
    const admin = await createUserWithRole(ctx, 'ADMIN');
    const person = await signedUpAccount(ctx, 'doctor');
    const ref = await licenceFile(admin.accessToken, person.userId);
    const form = { userId: person.userId, fullName: 'Dr. Abebe Kebede', specialty: 'Paediatrics', licenseNumber: 'EMA/MD/1', licenseExpiresOn: day(-1), documents: [{ kind: 'MEDICAL_LICENSE', storageRef: ref }] };
    const expired = await as(admin.accessToken).post('/admin/doctor-registrations', form);
    expect(expired.status).toBe(400);
    expect(errorOf(expired).message).toMatch(/expired/);

    const driver = await createUserWithRole(ctx, 'DRIVER');
    const driverRef = await licenceFile(admin.accessToken, driver.userId);
    const notCustomer = await as(admin.accessToken).post('/admin/doctor-registrations', { ...form, userId: driver.userId, licenseExpiresOn: day(30), documents: [{ kind: 'MEDICAL_LICENSE', storageRef: driverRef }] });
    expect(notCustomer.status).toBe(422);
    expect(await ctx.prisma.doctorProfile.count()).toBe(0);

    const customer = await createUserWithRole(ctx, 'CUSTOMER');
    await as(customer.accessToken).post('/admin/doctor-registrations', { ...form, licenseExpiresOn: day(30) }).expect(403);
    await as(customer.accessToken).get('/admin/doctors').expect(403);
  });
});
