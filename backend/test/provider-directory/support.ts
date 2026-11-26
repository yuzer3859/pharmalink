import request from 'supertest';
import { randomUUID } from 'crypto';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import { auth, body, createUserWithRole, login, STRONG_PASSWORD } from '../support/fixtures';
import type { TestContext } from '../support/test-app';

const PDF = Buffer.from('%PDF-1.4\n% PharmaLink test facility licence\n%%EOF\n');
const DAY = 24 * 60 * 60 * 1000;

/** A customer account that signed up with an e-mail address and confirmed it. */
export async function signedUpAccount(ctx: TestContext, prefix = 'facility') {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@pharmalink.test`;
  const registered = await request(ctx.server).post('/auth/register').send({ email, password: STRONG_PASSWORD }).expect(201);
  await ctx.drainOutbox();
  const code = ctx.notifications.lastCodeFor(email, 'otp-register');
  await request(ctx.server).post('/auth/verify-otp').send({ identifier: email, code, purpose: OtpPurpose.REGISTER }).expect(201);
  return { userId: body(registered).userId as string, email };
}

/**
 * Work 161: a healthcare provider registered and activated by a platform administrator (Work 160)
 * for a facility administrator, who is then signed in with their new organisation role.
 */
export async function registeredProvider(
  ctx: TestContext,
  options: { type?: 'HOSPITAL' | 'CLINIC' | 'DIAGNOSTIC_CENTER' | 'LAB'; displayName?: string; admin?: { accessToken: string }; facilityAdmin?: { userId: string; email: string } } = {},
) {
  const platformAdmin = options.admin ?? (await createUserWithRole(ctx, 'ADMIN'));
  const facilityAdmin = options.facilityAdmin ?? (await signedUpAccount(ctx));
  const issued = body(
    await request(ctx.server)
      .post('/admin/provider-registrations/uploads')
      .set(...auth(platformAdmin.accessToken))
      .send({ adminUserId: facilityAdmin.userId, contentType: 'application/pdf', bytes: PDF.length })
      .expect(201),
  ) as { storageRef: string; upload: { url: string } };
  await request(ctx.server).put(new URL(issued.upload.url).pathname).set('Content-Type', 'application/pdf').send(PDF).expect(200);
  const registered = body(
    await request(ctx.server)
      .post('/admin/provider-registrations')
      .set(...auth(platformAdmin.accessToken))
      .send({
        adminUserId: facilityAdmin.userId,
        type: options.type ?? 'HOSPITAL',
        legalName: `${options.displayName ?? 'Tikur Anbessa Hospital'} PLC ${randomUUID().slice(0, 4)}`,
        displayName: options.displayName ?? 'Tikur Anbessa Hospital',
        licenseNumber: `MOH/HF/${randomUUID().slice(0, 6)}`,
        licenseExpiresOn: new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10),
        documents: [{ kind: 'FACILITY_LICENSE', storageRef: issued.storageRef }],
        idempotencyKey: randomUUID(),
      })
      .expect(201),
  ) as { providerId: string; organizationId: string };
  const tokens = await login(ctx, facilityAdmin.email);
  return { ...registered, platformAdmin, facilityAdmin, token: tokens.accessToken };
}
