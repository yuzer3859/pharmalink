import { Injectable } from '@nestjs/common';
import request from 'supertest';
import { DomainEvent } from '../../src/shared/events/domain-event';
import { OutboxCapableClient, OutboxService } from '../../src/shared/outbox/outbox.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { auth, body, login, registerAndVerify } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const ADDIS = { lat: 9.03, lng: 38.74 };

function baseAddress(overrides: Record<string, unknown> = {}) {
  return {
    recipientName: 'Abebe Kebede',
    recipientPhone: '0911223344',
    region: 'Addis Ababa',
    city: 'Addis Ababa',
    addressLine: 'Bole Road',
    lat: ADDIS.lat,
    lng: ADDIS.lng,
    ...overrides,
  };
}

/**
 * A real `OutboxService` whose `write` can be armed to throw exactly once, simulating a failure
 * that occurs AFTER the domain state change (and, where applicable, the audit insert) have
 * already executed as statements inside the caller's still-open transaction, but before commit.
 * Everything else delegates to the real implementation, so this only perturbs the one write it's
 * armed for.
 */
@Injectable()
class PoisonedOutboxService extends OutboxService {
  armed = false;

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async write<T>(event: DomainEvent<T>, client?: OutboxCapableClient): Promise<void> {
    if (this.armed) {
      this.armed = false;
      throw new Error(
        'CONTROLLED_FAILURE: simulated outbox failure after the state mutation, before commit',
      );
    }
    return super.write(event, client);
  }
}

/**
 * DEFECT-PROFILES-002 / ADR-010 — proves that the domain state change, the audit entry, and the
 * outbox event for every Profile/Address mutation commit atomically in a single transaction. A
 * controlled failure is injected into the outbox write (the LAST statement in each command's
 * transaction) so that, if the domain mutation or the audit insert had already been committed
 * independently (the pre-fix behavior), this test would observe a partially-applied change; with
 * everything in one transaction, Postgres rolls back all of it.
 */
describe('Profile/Address mutation atomicity — DEFECT-PROFILES-002 (e2e)', () => {
  let ctx: TestContext;
  let poisonedOutbox: PoisonedOutboxService;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: OutboxService, useClass: PoisonedOutboxService }]);
    poisonedOutbox = ctx.app.get(OutboxService) as unknown as PoisonedOutboxService;
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    poisonedOutbox.armed = false;
  });

  async function customer() {
    const user = await registerAndVerify(ctx);
    const tokens = await login(ctx, user.phone, user.password);
    return { ...user, ...tokens };
  }

  it('POST /addresses: a failure after the insert rolls back the address row, the audit ' +
    'entry, and the outbox event together — no partial state survives', async () => {
    const user = await customer();

    poisonedOutbox.armed = true;
    const failed = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress());
    expect(failed.status).toBe(500);
    expect(poisonedOutbox.armed).toBe(false); // the poison was consumed by this attempt

    expect(await ctx.prisma.address.count({ where: { userId: user.userId } })).toBe(0);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ADDRESS_ADDED', actorUserId: user.userId } }),
    ).toBe(0);
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'profiles.address.added' } }),
    ).toBe(0);

    // Proves the failure was a one-shot injection, not a permanently broken command: the exact
    // same request, unpoisoned, now succeeds and commits all three together.
    const retried = await request(ctx.server)
      .post('/addresses')
      .set(...auth(user.accessToken))
      .send(baseAddress())
      .expect(201);

    expect(await ctx.prisma.address.count({ where: { userId: user.userId } })).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ADDRESS_ADDED', actorUserId: user.userId } }),
    ).toBe(1);
    expect(
      await ctx.prisma.outbox.count({
        where: { eventType: 'profiles.address.added', aggregateId: body(retried).id as string },
      }),
    ).toBe(1);
  });

  it('PATCH /profile/me: a failure after the profile save rolls back the profile edit, the ' +
    'audit entry, and the outbox event together (regression: this command previously had NO ' +
    'transaction at all)', async () => {
    const user = await customer();

    poisonedOutbox.armed = true;
    const failed = await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(user.accessToken))
      .send({ fullName: 'Should Not Persist' });
    expect(failed.status).toBe(500);
    expect(poisonedOutbox.armed).toBe(false);

    const profileAfterFailure = await ctx.prisma.customerProfile.findUnique({
      where: { userId: user.userId },
    });
    expect(profileAfterFailure?.fullName ?? null).toBeNull();
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PROFILE_UPDATED', actorUserId: user.userId } }),
    ).toBe(0);
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'profiles.profile.updated' } }),
    ).toBe(0);

    // Same request, unpoisoned, now succeeds and commits all three together.
    await request(ctx.server)
      .patch('/profile/me')
      .set(...auth(user.accessToken))
      .send({ fullName: 'Abebe Kebede' })
      .expect(200);

    const profileAfterSuccess = await ctx.prisma.customerProfile.findUnique({
      where: { userId: user.userId },
    });
    expect(profileAfterSuccess?.fullName).toBe('Abebe Kebede');
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'PROFILE_UPDATED', actorUserId: user.userId } }),
    ).toBe(1);
    expect(
      await ctx.prisma.outbox.count({ where: { eventType: 'profiles.profile.updated' } }),
    ).toBe(1);
  });

  it('POST /addresses/:id/default: a failure after the default swap rolls back the swap and ' +
    'the audit entry together — the previous default is left untouched', async () => {
    const user = await customer();
    const a = body(
      await request(ctx.server).post('/addresses').set(...auth(user.accessToken)).send(baseAddress()).expect(201),
    );
    const b = body(
      await request(ctx.server)
        .post('/addresses')
        .set(...auth(user.accessToken))
        .send(baseAddress({ recipientName: 'B B' }))
        .expect(201),
    );
    expect(a.isDefault).toBe(true);
    expect(b.isDefault).toBe(false);

    poisonedOutbox.armed = true;
    const failed = await request(ctx.server)
      .post(`/addresses/${b.id}/default`)
      .set(...auth(user.accessToken));
    expect(failed.status).toBe(500);

    // Neither address's isDefault flag moved — the swap was rolled back in full.
    const aRow = await ctx.prisma.address.findUniqueOrThrow({ where: { id: a.id as string } });
    const bRow = await ctx.prisma.address.findUniqueOrThrow({ where: { id: b.id as string } });
    expect(aRow.isDefault).toBe(true);
    expect(bRow.isDefault).toBe(false);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ADDRESS_DEFAULT_CHANGED' } }),
    ).toBe(0);

    await request(ctx.server)
      .post(`/addresses/${b.id}/default`)
      .set(...auth(user.accessToken))
      .expect(201);

    const aRowAfter = await ctx.prisma.address.findUniqueOrThrow({ where: { id: a.id as string } });
    const bRowAfter = await ctx.prisma.address.findUniqueOrThrow({ where: { id: b.id as string } });
    expect(aRowAfter.isDefault).toBe(false);
    expect(bRowAfter.isDefault).toBe(true);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'ADDRESS_DEFAULT_CHANGED' } }),
    ).toBe(1);
  });
});
