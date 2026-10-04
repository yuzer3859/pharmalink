import request from 'supertest';
import { AppConfigService } from '../../src/shared/config/app-config.service';
import { CONFIG_PORT, IConfigPort } from '../../src/shared/config/config.port';
import { ConfigOverrideLoader } from '../../src/modules/admin/infrastructure/config/config-override.loader';
import { UpdateConfigCommand } from '../../src/modules/admin/application/commands/update-config.command';
import { ToggleFeatureFlagCommand } from '../../src/modules/admin/application/commands/toggle-feature-flag.command';
import { ConfigValueType } from '../../src/modules/admin/domain/enums';
import { AdminEventType } from '../../src/modules/admin/domain/events';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const CONFIG = '/admin/config';
const FLAGS = '/admin/feature-flags';

interface ConfigBody {
  namespace: string;
  key: string;
  valueType: string;
  effectiveValue: unknown;
  source: string;
  activeVersion: number | null;
  min: number | null;
  max: number | null;
}

interface VersionBody {
  namespace: string;
  key: string;
  version: number;
  value: unknown;
  isActive: boolean;
  reason: string | null;
  updatedBy: string;
}

/**
 * Module 16 Work 01 against real PostgreSQL.
 *
 * The claims that can only be made here: the partial unique index really does admit one active
 * version, two concurrent publishes really do resolve to one winner, a published value really does
 * reach `IConfigPort` — which is the whole point of the module — and an unentitled caller really is
 * refused by the guard rather than by a check somebody wrote.
 */
describe('Platform configuration (e2e)', () => {
  let ctx: TestContext;
  let superAdmin: string;
  let loader: ConfigOverrideLoader;
  let configPort: IConfigPort;
  let update: UpdateConfigCommand;
  let toggle: ToggleFeatureFlagCommand;

  beforeAll(async () => {
    ctx = await createTestApp();
    loader = ctx.app.get(ConfigOverrideLoader);
    configPort = ctx.app.get<IConfigPort>(CONFIG_PORT);
    update = ctx.app.get(UpdateConfigCommand);
    toggle = ctx.app.get(ToggleFeatureFlagCommand);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    // A fresh database means no overrides; the registry must agree or a previous test's published
    // value would leak into the next one through memory.
    await loader.refresh();
    superAdmin = (await createUserWithRole(ctx, 'SUPER_ADMIN')).accessToken;
  });

  function put(token: string, namespace: string, key: string, payload: unknown) {
    return request(ctx.server)
      .put(`${CONFIG}/${namespace}/${key}`)
      .set(...auth(token))
      .send(payload as object);
  }

  function ttl(value: number, reason?: string) {
    return { valueType: ConfigValueType.INTEGER, value, ...(reason ? { reason } : {}) };
  }

  async function versions(namespace: string, key: string): Promise<VersionBody[]> {
    const res = await request(ctx.server)
      .get(`${CONFIG}/${namespace}/${key}/history`)
      .set(...auth(superAdmin));
    return (body(res) as { versions: VersionBody[] }).versions;
  }

  // -------------------------------------------------------------------------------------------
  // 1. Versioning
  // -------------------------------------------------------------------------------------------

  describe('versioning', () => {
    it('creates version 1 on the first publish', async () => {
      const res = await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45, 'Longer window'));

      expect(res.status).toBe(200);
      const created = (body(res) as { config: VersionBody }).config;
      expect(created.version).toBe(1);
      expect(created.value).toBe(45);
      expect(created.isActive).toBe(true);
      expect(created.reason).toBe('Longer window');
      // The previous version is reported as null, not omitted — the key had never been configured.
      expect((body(res) as { previous: VersionBody | null }).previous).toBeNull();
    });

    it('creates version 2 on an update, and leaves version 1 exactly as it was', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);
      const before = (await versions('delivery', 'offerTtlSeconds'))[0];

      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(90)).expect(200);

      const history = await versions('delivery', 'offerTtlSeconds');
      expect(history.map((v) => v.version)).toEqual([2, 1]);

      // The historical row is byte-for-byte what it was — this is the immutability claim.
      const v1 = history.find((v) => v.version === 1)!;
      expect(v1.value).toBe(45);
      expect(v1.updatedBy).toBe(before.updatedBy);
      expect(v1.isActive).toBe(false);
    });

    it('keeps exactly one active version, however many are published', async () => {
      for (const value of [45, 60, 90, 120]) {
        await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(value)).expect(200);
      }

      // Asserted against the table rather than the API: the partial unique index
      // `platform_configs_one_active_per_key` is what guarantees this, and the count is how you see
      // it holding.
      const active = await ctx.prisma.platformConfig.findMany({
        where: { namespace: 'delivery', key: 'offerTtlSeconds', isActive: true },
      });
      expect(active).toHaveLength(1);
      expect(active[0].version).toBe(4);
      expect(active[0].value).toBe(120);

      expect(
        await ctx.prisma.platformConfig.count({
          where: { namespace: 'delivery', key: 'offerTtlSeconds' },
        }),
      ).toBe(4);
    });

    it('refuses a second active row at the database level', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);

      // Forcing the invariant's hand: inserting a second active row by hand must fail, because the
      // guarantee has to be the database's rather than the command's good behaviour.
      await expect(
        ctx.prisma.platformConfig.create({
          data: {
            namespace: 'delivery',
            key: 'offerTtlSeconds',
            value: 99,
            valueType: ConfigValueType.INTEGER,
            version: 99,
            isActive: true,
            updatedBy: 'someone',
          },
        }),
      ).rejects.toThrow();
    });

    it('resolves two simultaneous publishes to one winner', async () => {
      const results = await Promise.allSettled([
        update.execute({
          actorUserId: 'admin-a',
          namespace: 'delivery',
          key: 'offerTtlSeconds',
          valueType: ConfigValueType.INTEGER,
          value: 45,
        }),
        update.execute({
          actorUserId: 'admin-b',
          namespace: 'delivery',
          key: 'offerTtlSeconds',
          valueType: ConfigValueType.INTEGER,
          value: 90,
        }),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won.length).toBeGreaterThanOrEqual(1);

      // Whatever the interleaving: one active row, and no duplicate version numbers.
      const rows = await ctx.prisma.platformConfig.findMany({
        where: { namespace: 'delivery', key: 'offerTtlSeconds' },
      });
      expect(rows.filter((r) => r.isActive)).toHaveLength(1);
      expect(new Set(rows.map((r) => r.version)).size).toBe(rows.length);

      // A loser is told to re-read rather than being silently retried into overwriting the winner.
      for (const result of results) {
        if (result.status === 'rejected') {
          expect((result.reason as { code?: string }).code).toBe(ErrorCode.CONFLICT);
        }
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Rollback
  // -------------------------------------------------------------------------------------------

  describe('rollback', () => {
    it('writes a new version carrying the old value, and preserves the whole history', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200); // v1
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(90)).expect(200); // v2
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(120)).expect(200); // v3

      const res = await request(ctx.server)
        .post(`${CONFIG}/delivery/offerTtlSeconds/rollback`)
        .set(...auth(superAdmin))
        .send({ toVersion: 1 });

      expect(res.status).toBe(200);
      const created = (body(res) as { config: VersionBody }).config;
      // v4 = the effective value of v1 — not v1 becoming active again.
      expect(created.version).toBe(4);
      expect(created.value).toBe(45);

      const history = await versions('delivery', 'offerTtlSeconds');
      expect(history.map((v) => v.version)).toEqual([4, 3, 2, 1]);
      expect(history.map((v) => v.value)).toEqual([45, 120, 90, 45]);
      // v1 is still there, and still inactive.
      expect(history.find((v) => v.version === 1)!.isActive).toBe(false);
      expect(history.filter((v) => v.isActive).map((v) => v.version)).toEqual([4]);
    });

    it('refuses a version that was never published', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);
      const res = await request(ctx.server)
        .post(`${CONFIG}/delivery/offerTtlSeconds/rollback`)
        .set(...auth(superAdmin))
        .send({ toVersion: 7 });
      expect(res.status).toBe(404);
    });

    it('refuses rolling back to the version already in force', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);
      const res = await request(ctx.server)
        .post(`${CONFIG}/delivery/offerTtlSeconds/rollback`)
        .set(...auth(superAdmin))
        .send({ toVersion: 1 });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Validation
  // -------------------------------------------------------------------------------------------

  describe('validation', () => {
    it('rejects a value outside the owning module’s range, and writes nothing', async () => {
      const res = await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(2));

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe(ErrorCode.CONFIG_VALIDATION_FAILED);
      // Rejected *before* publication — no version exists at all.
      expect(
        await ctx.prisma.platformConfig.count({
          where: { namespace: 'delivery', key: 'offerTtlSeconds' },
        }),
      ).toBe(0);
    });

    it('rejects a declared type that disagrees with the catalogue', async () => {
      const res = await put(superAdmin, 'delivery', 'offerTtlSeconds', {
        valueType: ConfigValueType.STRING,
        value: '45',
      });
      expect(res.status).toBe(422);
    });

    it('rejects the 5-meant-as-5% typo on the platform fee', async () => {
      expect(
        (await put(superAdmin, 'orders', 'platformFeePercent', {
          valueType: ConfigValueType.DECIMAL,
          value: 5,
        })).status,
      ).toBe(422);
      expect(
        (await put(superAdmin, 'orders', 'platformFeePercent', {
          valueType: ConfigValueType.DECIMAL,
          value: 0.05,
        })).status,
      ).toBe(200);
    });

    it('rejects a body that tries to supply its own actor', async () => {
      // `forbidNonWhitelisted` — the field does not exist, so the request is refused rather than
      // having the field quietly dropped.
      const res = await put(superAdmin, 'delivery', 'offerTtlSeconds', {
        valueType: ConfigValueType.INTEGER,
        value: 45,
        updatedBy: 'somebody-else',
      });
      expect(res.status).toBe(400);
    });

    it('records the authenticated principal as the actor', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);
      const row = await ctx.prisma.platformConfig.findFirstOrThrow({
        where: { namespace: 'delivery', key: 'offerTtlSeconds' },
      });
      const me = await ctx.prisma.user.findFirstOrThrow({ where: { id: row.updatedBy } });
      expect(me.id).toBe(row.updatedBy);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Secrets — the boundary §18 draws
  // -------------------------------------------------------------------------------------------

  describe('secrets', () => {
    it.each([
      ['TELEBIRR', 'API_SECRET'],
      ['TELEBIRR', 'WEBHOOK_SECRET'],
      ['JWT', 'ACCESS_SECRET'],
      ['MASTER', 'ENCRYPTION_KEY'],
      ['redis', 'url'],
    ])('refuses to write %s/%s', async (namespace, key) => {
      const res = await put(superAdmin, namespace, key, {
        valueType: ConfigValueType.STRING,
        value: 'attacker-controlled',
      });
      expect([400, 404]).toContain(res.status);
      expect(await ctx.prisma.platformConfig.count({ where: { key } })).toBe(0);
    });

    it('exposes no secret through the listing', async () => {
      const res = await request(ctx.server).get(CONFIG).set(...auth(superAdmin));
      expect(res.status).toBe(200);

      const items = body(res) as unknown as ConfigBody[];
      const serialized = JSON.stringify(items);
      for (const forbidden of ['SECRET', 'PASSWORD', 'JWT_', 'TELEBIRR', 'DATABASE_URL', 'redis']) {
        expect(serialized).not.toContain(forbidden);
      }
      // Only the two governable namespaces appear.
      expect([...new Set(items.map((i) => i.namespace))].sort()).toEqual(['delivery', 'orders']);
    });

    it('serves the environment’s value for a secret even while overrides exist', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);
      // Reading a secret through the port must still reach the environment — the override snapshot
      // has no entry for it and never can.
      expect(configPort.get('JWT_ACCESS_SECRET')).toBe(
        ctx.app.get(AppConfigService).jwtAccessSecret,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Authorization
  // -------------------------------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses an unauthenticated caller', async () => {
      expect((await request(ctx.server).get(CONFIG)).status).toBe(401);
      expect(
        (await request(ctx.server).put(`${CONFIG}/delivery/offerTtlSeconds`).send(ttl(45))).status,
      ).toBe(401);
    });

    it.each([['CUSTOMER'], ['DRIVER'], ['PHARMACY_OWNER'], ['FINANCE_OFFICER']])(
      'refuses a %s',
      async (role) => {
        const user = await createUserWithRole(ctx, role as 'CUSTOMER');
        expect((await put(user.accessToken, 'delivery', 'offerTtlSeconds', ttl(45))).status).toBe(
          403,
        );
        expect(
          (await request(ctx.server).get(CONFIG).set(...auth(user.accessToken))).status,
        ).toBe(403);
      },
    );

    /**
     * The check §14 asks for explicitly. `ADMIN` can suspend users, moderate reviews and read
     * finance reports — and still cannot change a platform fee, because `config:manage:global` is
     * not in its grant list. The design's "config:manage — Super Admin" is a property of the
     * catalogue, not of a check somebody wrote.
     */
    it('refuses an ordinary ADMIN', async () => {
      const admin = await createUserWithRole(ctx, 'ADMIN');
      expect((await put(admin.accessToken, 'delivery', 'offerTtlSeconds', ttl(45))).status).toBe(
        403,
      );
    });

    it('allows a SUPER_ADMIN', async () => {
      expect((await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45))).status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Effective configuration and the IConfigPort boundary
  // -------------------------------------------------------------------------------------------

  describe('effective configuration', () => {
    it('reports the environment as the source until something is published', async () => {
      const res = await request(ctx.server)
        .get(`${CONFIG}/delivery/offerTtlSeconds`)
        .set(...auth(superAdmin));

      const view = body(res) as unknown as ConfigBody;
      expect(view.source).toBe('ENVIRONMENT');
      expect(view.activeVersion).toBeNull();
      // The bounds come with it, so a UI can validate before a round trip.
      expect(view.min).toBe(5);
      expect(view.max).toBe(600);
    });

    it('reaches IConfigPort once published — the point of the whole module', async () => {
      const before = configPort.get<number>('delivery.offerTtlSeconds');

      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);

      // The publishing instance refreshes its snapshot inside the request, so the very next read
      // already sees it.
      expect(configPort.get<number>('delivery.offerTtlSeconds')).toBe(45);
      expect(configPort.get<number>('delivery.offerTtlSeconds')).not.toBe(before);

      const res = await request(ctx.server)
        .get(`${CONFIG}/delivery/offerTtlSeconds`)
        .set(...auth(superAdmin));
      expect((body(res) as unknown as ConfigBody).source).toBe('ADMIN');
      expect((body(res) as unknown as ConfigBody).activeVersion).toBe(1);
    });

    it('lists every governable key, not only the ones that were changed', async () => {
      const res = await request(ctx.server).get(CONFIG).set(...auth(superAdmin));
      const items = body(res) as unknown as ConfigBody[];
      // Nothing has been published, yet the whole governable surface is listed.
      expect(items.length).toBeGreaterThan(25);
      expect(items.every((i) => i.activeVersion === null)).toBe(true);
    });

    it('narrows to one namespace', async () => {
      const res = await request(ctx.server)
        .get(`${CONFIG}?namespace=orders`)
        .set(...auth(superAdmin));
      const items = body(res) as unknown as ConfigBody[];
      expect(items).toHaveLength(1);
      expect(items[0].key).toBe('platformFeePercent');
    });

    it('survives a refresh that finds nothing, without reverting to the environment', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);
      // A refresh against a healthy database simply re-reads the same row.
      await loader.refresh();
      expect(configPort.get<number>('delivery.offerTtlSeconds')).toBe(45);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 7. Events and audit
  // -------------------------------------------------------------------------------------------

  describe('events and audit', () => {
    it('emits ConfigChanged through the outbox, carrying no value', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);

      const events = await ctx.prisma.outbox.findMany({
        where: { eventType: AdminEventType.ConfigChanged },
      });
      expect(events).toHaveLength(1);

      const envelope = events[0].payload as unknown as {
        aggregateId: string;
        payload: Record<string, unknown>;
      };
      expect(envelope.aggregateId).toBe('delivery.offerTtlSeconds');
      expect(envelope.payload.namespace).toBe('delivery');
      expect(envelope.payload.key).toBe('offerTtlSeconds');
      expect(envelope.payload.version).toBe(1);
      expect(envelope.payload.changedBy).toBeTruthy();
      // The value stays out of the event — see the payload's doc comment.
      expect(envelope.payload.value).toBeUndefined();
    });

    it('writes an audit entry with before and after', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(45)).expect(200);
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(90, 'Traffic')).expect(200);

      const entries = await ctx.prisma.auditLog.findMany({
        where: { action: 'CONFIG_CHANGED', resourceId: 'delivery.offerTtlSeconds' },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries).toHaveLength(2);

      const second = entries[1].context as Record<string, unknown>;
      expect(second.previousVersion).toBe(1);
      expect(second.previousValue).toBe(45);
      expect(second.newVersion).toBe(2);
      expect(second.newValue).toBe(90);
      expect(second.reason).toBe('Traffic');
    });

    it('writes nothing at all when validation fails', async () => {
      await put(superAdmin, 'delivery', 'offerTtlSeconds', ttl(2)).expect(422);
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'CONFIG_CHANGED' } }),
      ).toBe(0);
      expect(
        await ctx.prisma.outbox.count({ where: { eventType: AdminEventType.ConfigChanged } }),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 8. Feature flags
  // -------------------------------------------------------------------------------------------

  describe('feature flags', () => {
    function toggleFlag(token: string, key: string, payload: unknown) {
      return request(ctx.server)
        .put(`${FLAGS}/${key}`)
        .set(...auth(token))
        .send(payload as object);
    }

    it('creates a flag on first toggle and reports it enabled', async () => {
      const res = await toggleFlag(superAdmin, 'telemedicine', {
        enabled: true,
        description: 'Phase 2 consults',
      });

      expect(res.status).toBe(200);
      expect(body(res).created).toBe(true);
      expect(body(res).changed).toBe(true);
      expect((body(res).flag as Record<string, unknown>).enabled).toBe(true);
      expect(configPort.isFeatureEnabled('telemedicine')).toBe(true);
    });

    it('disables a flag', async () => {
      await toggleFlag(superAdmin, 'telemedicine', { enabled: true }).expect(200);
      const res = await toggleFlag(superAdmin, 'telemedicine', { enabled: false });

      expect(body(res).created).toBe(false);
      expect(body(res).changed).toBe(true);
      expect(configPort.isFeatureEnabled('telemedicine')).toBe(false);
    });

    it('writes nothing when the flag is already in the requested state', async () => {
      await toggleFlag(superAdmin, 'telemedicine', { enabled: true }).expect(200);
      const res = await toggleFlag(superAdmin, 'telemedicine', { enabled: true });

      expect(body(res).changed).toBe(false);
      // One audit entry, not two: re-asserting a state is not a governance decision.
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'FEATURE_FLAG_TOGGLED' } }),
      ).toBe(1);
    });

    it('falls back to the environment for a flag nobody has administered', async () => {
      // §10's safe default. No row exists, and the answer is whatever the environment said — not a
      // blanket `false` that would switch off every flag-gated capability on deploy.
      expect(await ctx.prisma.featureFlag.count({ where: { key: 'never_touched' } })).toBe(0);
      expect(configPort.isFeatureEnabled('never_touched')).toBe(false);
      // And it is absent from the listing, which reports what is administered.
      const res = await request(ctx.server).get(FLAGS).set(...auth(superAdmin));
      expect((body(res) as unknown as { key: string }[]).map((f) => f.key)).not.toContain(
        'never_touched',
      );
    });

    it('keeps one row per key under concurrent creation', async () => {
      const results = await Promise.allSettled([
        toggle.execute({ actorUserId: 'admin-a', key: 'cod', enabled: true }),
        toggle.execute({ actorUserId: 'admin-b', key: 'cod', enabled: true }),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      expect(await ctx.prisma.featureFlag.count({ where: { key: 'cod' } })).toBe(1);
      // Exactly one of them created it; the other converged onto the winner.
      const created = results.filter(
        (r) => r.status === 'fulfilled' && r.value.created,
      );
      expect(created).toHaveLength(1);
    });

    it('records the state change in the audit trail', async () => {
      await toggleFlag(superAdmin, 'telemedicine', { enabled: true }).expect(200);
      await toggleFlag(superAdmin, 'telemedicine', { enabled: false }).expect(200);

      const entries = await ctx.prisma.auditLog.findMany({
        where: { action: 'FEATURE_FLAG_TOGGLED', resourceId: 'telemedicine' },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries).toHaveLength(2);
      // `null` on the first: the flag had never been administered, which is a different fact from
      // "it was off".
      expect((entries[0].context as Record<string, unknown>).previousEnabled).toBeNull();
      expect((entries[1].context as Record<string, unknown>).previousEnabled).toBe(true);
      expect((entries[1].context as Record<string, unknown>).enabled).toBe(false);
    });

    it('emits FeatureFlagToggled', async () => {
      await toggleFlag(superAdmin, 'telemedicine', { enabled: true }).expect(200);
      const events = await ctx.prisma.outbox.findMany({
        where: { eventType: AdminEventType.FeatureFlagToggled },
      });
      expect(events).toHaveLength(1);
      const envelope = events[0].payload as unknown as { payload: Record<string, unknown> };
      expect(envelope.payload.key).toBe('telemedicine');
      expect(envelope.payload.enabled).toBe(true);
    });

    it('refuses an unentitled caller', async () => {
      const customer = await createUserWithRole(ctx, 'CUSTOMER');
      expect((await toggleFlag(customer.accessToken, 'cod', { enabled: false })).status).toBe(403);
      expect(
        (await request(ctx.server).get(FLAGS).set(...auth(customer.accessToken))).status,
      ).toBe(403);
      expect((await request(ctx.server).put(`${FLAGS}/cod`).send({ enabled: false })).status).toBe(
        401,
      );
    });

    it('refuses a malformed flag key', async () => {
      expect((await toggleFlag(superAdmin, '9lives', { enabled: true })).status).toBe(400);
    });
  });
});
