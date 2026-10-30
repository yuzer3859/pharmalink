import request from 'supertest';
import {
  BootstrapRefusedError,
  BootstrapSuperAdminCommand,
} from '../../src/modules/identity/application/commands/bootstrap-super-admin.command';
import { HASHER, IHasher } from '../../src/modules/identity/application/ports/hasher.port';
import { OTP_STORE_PROBE } from '../../src/modules/identity/application/ports/otp-store-probe.port';
import { OtpPurpose } from '../../src/modules/identity/domain/enums';
import {
  EXIT_CREATED_NOT_SENT,
  EXIT_OK,
  EXIT_REFUSED,
  runBootstrapSuperAdmin,
} from '../../src/cli/bootstrap-super-admin.runner';
import { createBootstrapContext } from '../../src/cli/bootstrap-context';
import { CliIo } from '../../src/cli/terminal-prompter';
import { declareCliProcess, isCliProcess } from '../../src/shared/config/process-role';
import { AppConfigService } from '../../src/shared/config/app-config.service';
import { auth, body, createUserWithRole, DEVICE, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

/**
 * Work 65: the one-time, operator-only first Super Admin bootstrap, against the real Identity
 * wiring and database. Delivery goes to the recording notification adapter (never a real e-mail).
 *
 * The OTP store probe is the one override: the harness uses the in-memory store, which the CLI
 * correctly refuses because a separate CLI process could not share it with the server. Here the
 * "CLI" runs inside the same process as the HTTP app, so the store genuinely is shared.
 */
const EMAIL = 'founder@pharmalink.test';
const PASSWORD = 'Bootstr4pPassword';

function scriptedIo(answers: string[]) {
  const printed: string[] = [];
  const queue = [...answers];
  const io: CliIo = {
    ask: async () => queue.shift() ?? '',
    askHidden: async () => queue.shift() ?? '',
    print: (line) => printed.push(line),
    close: () => undefined,
  };
  return { io, printed };
}

describe('First Super Admin bootstrap (e2e)', () => {
  let ctx: TestContext;
  let command: BootstrapSuperAdminCommand;

  beforeAll(async () => {
    ctx = await createTestApp([{ provide: OTP_STORE_PROBE, useValue: { probe: async () => ({ shared: true }) } }]);
    command = ctx.app.get(BootstrapSuperAdminCommand);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const counts = async () => ({
    users: await ctx.prisma.user.count(),
    userRoles: await ctx.prisma.userRole.count(),
    markers: await ctx.prisma.platformBootstrap.count(),
    audit: await ctx.prisma.auditLog.count(),
    outbox: await ctx.prisma.outbox.count(),
  });

  async function refusedReason(promise: Promise<unknown>): Promise<string> {
    const err = await promise.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BootstrapRefusedError);
    return (err as BootstrapRefusedError).reason;
  }

  it('creates one pending Super Admin through the CLI conversation, sends one code, and prints no secret', async () => {
    const { io, printed } = scriptedIo([EMAIL, PASSWORD, PASSWORD]);
    expect(await runBootstrapSuperAdmin(command, io)).toBe(EXIT_OK);

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user).toMatchObject({
      primaryRole: 'SUPER_ADMIN',
      status: 'PENDING_VERIFICATION',
      emailVerifiedAt: null,
      faydaVerifiedAt: null,
      phone: null,
    });
    // Stored only as a hash, which the real hasher accepts.
    expect(user.passwordHash).not.toBe(PASSWORD);
    expect(user.passwordHash).not.toContain(PASSWORD);
    await expect(ctx.app.get<IHasher>(HASHER).verify(PASSWORD, user.passwordHash as string)).resolves.toBe(true);

    const roles = await ctx.prisma.userRole.findMany({ where: { userId: user.id }, include: { role: true } });
    expect(roles.map((r) => ({ key: r.role.key, organizationId: r.organizationId, assignedBy: r.assignedBy }))).toEqual([
      { key: 'SUPER_ADMIN', organizationId: null, assignedBy: null },
    ]);
    const marker = await ctx.prisma.platformBootstrap.findUniqueOrThrow({ where: { key: 'FIRST_SUPER_ADMIN' } });
    expect(marker.superAdminUserId).toBe(user.id);

    const entry = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'identity.platform.super_admin_bootstrapped' } });
    expect(entry).toMatchObject({ actorUserId: null, resourceType: 'user', resourceId: user.id });

    // Exactly one REGISTER code, by e-mail; no UserRegistered event that could send a second one.
    const codes = ctx.notifications.sent.filter((n) => n.template === 'otp-register');
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ channel: 'EMAIL', to: EMAIL });
    expect(await ctx.prisma.outbox.count({ where: { eventType: 'identity.user.registered' } })).toBe(0);
    await ctx.drainOutbox();
    expect(ctx.notifications.sent.filter((n) => n.template === 'otp-register')).toHaveLength(1);

    const output = printed.join('\n');
    const code = ctx.notifications.lastCodeFor(EMAIL, 'otp-register');
    for (const secret of [PASSWORD, code, user.passwordHash as string, EMAIL]) expect(output).not.toContain(secret);
    expect(JSON.stringify(entry.context)).not.toContain(PASSWORD);
    expect(JSON.stringify(entry.context)).not.toContain(code);
  });

  it('activates only through the normal e-mail OTP verification, then holds the wildcard', async () => {
    await command.execute({ email: EMAIL, password: PASSWORD });

    const before = await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: EMAIL, password: PASSWORD, deviceInfo: DEVICE })
      .expect(401);
    expect(errorOf(before).code).toBe('AUTH_INVALID_CREDENTIALS');

    const code = ctx.notifications.lastCodeFor(EMAIL, 'otp-register');
    await request(ctx.server)
      .post('/auth/verify-otp')
      .send({ identifier: EMAIL, code, purpose: OtpPurpose.REGISTER })
      .expect(201);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.status).toBe('ACTIVE');
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.faydaVerifiedAt).toBeNull();

    const tokens = body(
      await request(ctx.server)
        .post('/auth/login')
        .send({ identifier: EMAIL, password: PASSWORD, deviceInfo: DEVICE })
        .expect(201),
    );
    const me = body(await request(ctx.server).get('/users/me').set(...auth(tokens.accessToken as string)).expect(200));
    expect(me).toMatchObject({ primaryRole: 'SUPER_ADMIN', faydaVerified: false });
    expect(me.permissions).toContain('*');
    await request(ctx.server).get('/admin/rbac/roles').set(...auth(tokens.accessToken as string)).expect(200);
  });

  it('is permanently one-time: a second run is refused and creates nothing', async () => {
    await command.execute({ email: EMAIL, password: PASSWORD });
    const after = await counts();
    expect(await refusedReason(command.execute({ email: 'second@pharmalink.test', password: PASSWORD }))).toBe('ALREADY_COMPLETED');
    expect(await counts()).toEqual(after);
  });

  it('stays consumed even if the first Super Admin is later demoted', async () => {
    await command.execute({ email: EMAIL, password: PASSWORD });
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    await ctx.prisma.userRole.deleteMany({ where: { userId: user.id } });
    await ctx.prisma.user.update({ where: { id: user.id }, data: { primaryRole: 'CUSTOMER' } });
    expect(await refusedReason(command.execute({ email: 'second@pharmalink.test', password: PASSWORD }))).toBe('ALREADY_COMPLETED');
  });

  it('keeps the marker write-once at the database level', async () => {
    await command.execute({ email: EMAIL, password: PASSWORD });
    await expect(ctx.prisma.platformBootstrap.deleteMany({})).rejects.toThrow(/write-once/);
    await expect(
      ctx.prisma.platformBootstrap.updateMany({ data: { completedAt: new Date(0) } }),
    ).rejects.toThrow(/write-once/);
    await expect(
      ctx.prisma.platformBootstrap.create({ data: { key: 'SECOND', superAdminUserId: (await ctx.prisma.user.findFirstOrThrow()).id } }),
    ).rejects.toThrow();
    expect(await ctx.prisma.platformBootstrap.count()).toBe(1);
  });

  it('refuses a database that already has a Super Admin without a bootstrap record', async () => {
    await createUserWithRole(ctx, 'SUPER_ADMIN');
    const before = await counts();
    expect(await refusedReason(command.execute({ email: EMAIL, password: PASSWORD }))).toBe('SUPER_ADMIN_EXISTS');
    expect(await counts()).toEqual(before);
  });

  it('lets exactly one of two concurrent runs succeed', async () => {
    const results = await Promise.allSettled([
      command.execute({ email: 'one@pharmalink.test', password: PASSWORD }),
      command.execute({ email: 'two@pharmalink.test', password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BootstrapRefusedError);
    expect((rejected[0].reason as BootstrapRefusedError).reason).toBe('ALREADY_COMPLETED');
    expect(await ctx.prisma.user.count({ where: { primaryRole: 'SUPER_ADMIN' } })).toBe(1);
    expect(await ctx.prisma.userRole.count({ where: { role: { key: 'SUPER_ADMIN' } } })).toBe(1);
    expect(await ctx.prisma.platformBootstrap.count()).toBe(1);
  });

  it('fails cleanly when the RBAC seed is missing, without creating the role', async () => {
    const role = await ctx.prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
    await ctx.prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    const before = await counts();
    expect(await refusedReason(command.execute({ email: EMAIL, password: PASSWORD }))).toBe('ROLE_CATALOGUE_MISSING');
    expect(await counts()).toEqual(before);
    expect(await ctx.prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(0);
  });

  it('writes nothing when e-mail delivery is not configured', async () => {
    ctx.notifications.unavailable.add('EMAIL');
    const before = await counts();
    const { io, printed } = scriptedIo([EMAIL, PASSWORD, PASSWORD]);
    expect(await runBootstrapSuperAdmin(command, io)).toBe(EXIT_REFUSED);
    expect(printed.join('\n')).toContain('EMAIL_NOT_CONFIGURED');
    expect(await counts()).toEqual(before);
  });

  it('never activates the account when delivery fails, and does not allow a second bootstrap', async () => {
    ctx.notifications.failing.add('EMAIL');
    const { io, printed } = scriptedIo([EMAIL, PASSWORD, PASSWORD]);
    expect(await runBootstrapSuperAdmin(command, io)).toBe(EXIT_CREATED_NOT_SENT);
    expect(printed.join('\n')).toContain('was NOT sent');

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(user.status).toBe('PENDING_VERIFICATION');
    expect(user.emailVerifiedAt).toBeNull();
    expect(ctx.notifications.sent).toHaveLength(0);
    await request(ctx.server)
      .post('/auth/login')
      .send({ identifier: EMAIL, password: PASSWORD, deviceInfo: DEVICE })
      .expect(401);
    expect(await ctx.prisma.platformBootstrap.count()).toBe(1);
    expect(await refusedReason(command.execute({ email: 'second@pharmalink.test', password: PASSWORD }))).toBe('ALREADY_COMPLETED');

    // Recovery is the normal resend flow, which honours the cooldown the undelivered code started.
    ctx.notifications.failing.clear();
    const resend = await request(ctx.server)
      .post('/auth/resend-otp')
      .send({ identifier: EMAIL, purpose: OtpPurpose.REGISTER })
      .expect(429);
    expect(errorOf(resend).code).toBe('RATE_LIMITED');
  });

  it('refuses invalid input before writing', async () => {
    const before = await counts();
    expect(await refusedReason(command.execute({ email: 'nope', password: PASSWORD }))).toBe('INVALID_EMAIL');
    expect(await refusedReason(command.execute({ email: EMAIL, password: 'weakpassword' }))).toBe('WEAK_PASSWORD');
    expect(await counts()).toEqual(before);
  });
});

describe('First Super Admin bootstrap CLI context (e2e)', () => {
  it('runs as a CLI application context with no HTTP listener and no background jobs', async () => {
    declareCliProcess();
    const app = await createBootstrapContext();
    try {
      expect(isCliProcess()).toBe(true);
      expect(app.get(AppConfigService).runsBackgroundJobs).toBe(false);
      expect((app as unknown as { listen?: unknown }).listen).toBeUndefined();
      expect((app as unknown as { getHttpServer?: unknown }).getHttpServer).toBeUndefined();

      // Under NODE_ENV=test the real Resend config is never configured, so the CLI stops at its
      // preconditions, before asking for credentials or writing anything.
      const { io, printed } = scriptedIo([]);
      expect(await runBootstrapSuperAdmin(app.get(BootstrapSuperAdminCommand), io)).toBe(EXIT_REFUSED);
      expect(printed.join('\n')).toContain('EMAIL_NOT_CONFIGURED');
    } finally {
      await app.close();
    }
  });
});
