import request from 'supertest';
import { auth, body, createUserWithRole, login } from '../support/fixtures';
import type { TestContext } from '../support/test-app';
import { signedUpAccount } from '../provider-directory/support';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink test medical licence\n%%EOF\n');
const DAY = 24 * 60 * 60 * 1000;
export const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

/** Work 166: a doctor registered by a platform administrator, then signed in with role DOCTOR. */
export async function registeredDoctor(
  ctx: TestContext,
  options: { admin?: { accessToken: string; userId: string }; fullName?: string; specialty?: string } = {},
) {
  const platformAdmin = options.admin ?? (await createUserWithRole(ctx, 'ADMIN'));
  const person = await signedUpAccount(ctx, 'doctor');
  const issued = body(
    await request(ctx.server)
      .post('/admin/doctor-registrations/uploads')
      .set(...auth(platformAdmin.accessToken))
      .send({ userId: person.userId, contentType: 'application/pdf', bytes: PDF.length })
      .expect(201),
  ) as { storageRef: string; upload: { url: string } };
  await request(ctx.server).put(new URL(issued.upload.url).pathname).set('Content-Type', 'application/pdf').send(PDF).expect(200);
  const res = await request(ctx.server)
    .post('/admin/doctor-registrations')
    .set(...auth(platformAdmin.accessToken))
    .send({
      userId: person.userId,
      fullName: options.fullName ?? 'Dr. Selamawit Bekele',
      specialty: options.specialty ?? 'Cardiology',
      licenseNumber: `EMA/MD/${person.userId.slice(0, 6)}`,
      licenseExpiresOn: day(365),
      documents: [{ kind: 'MEDICAL_LICENSE', storageRef: issued.storageRef }],
    })
    .expect(201);
  const { doctorId } = body(res) as { doctorId: string };
  const tokens = await login(ctx, person.email);
  return { doctorId, person, platformAdmin, token: tokens.accessToken };
}
