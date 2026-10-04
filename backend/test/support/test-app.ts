import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import { AppModule } from '../../src/app.module';
import { NOTIFICATION_PORT } from '../../src/modules/identity/application/ports/notification.port';
import { OutboxRelay } from '../../src/shared/outbox/outbox-relay.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { PermissionCacheService } from '../../src/shared/rbac/permission-cache.service';
import { PERM_VERSION_STORE } from '../../src/modules/identity/application/ports/perm-version.port';
import { CachedPermVersionStore } from '../../src/modules/identity/infrastructure/security/cached-perm-version.store';
import { RecordingNotificationAdapter } from './recording-notification.adapter';
import { assertTestDatabase, resetDatabase } from './test-database';

export interface TestContext {
  app: INestApplication;
  server: Server;
  /**
   * `http://127.0.0.1:<port>` once the app is listening, otherwise `null`.
   *
   * Only a socket client needs this. Supertest drives the in-memory `server` handle directly and
   * never binds a port, which is why listening is opt-in rather than the default — a bound port
   * per spec would be two dozen ports the suite does not need.
   */
  url: string | null;
  prisma: PrismaService;
  notifications: RecordingNotificationAdapter;
  /** Publishes pending outbox events (the relay's timer is disabled under NODE_ENV=test). */
  drainOutbox(): Promise<void>;
  /** Truncates + re-seeds, and clears the in-process caches that would otherwise leak state. */
  reset(): Promise<void>;
}

/**
 * A provider override applied on top of the real `AppModule` wiring — e.g. a test double that
 * injects a controlled failure into an otherwise-real service, to prove a transaction rolls back
 * completely (DEFECT-PROFILES-002). `useClass` still goes through Nest's DI (constructor
 * injection works normally), so it's the right shape for a subclass of a real `@Injectable()`.
 */
export interface TestAppOverride {
  provide: unknown;
  useClass?: new (...args: never[]) => unknown;
  useValue?: unknown;
}

export interface TestAppOptions {
  /**
   * Bind an ephemeral port.
   *
   * Required for WebSocket specs: a socket.io client connects over a real TCP socket, so the
   * gateway has to be attached to a listening HTTP server rather than only mounted on the Nest
   * application. Port `0` lets the OS choose, so two app instances in one spec — which is how the
   * cross-instance fan-out claim is proved — cannot collide.
   */
  listen?: boolean;
}

/**
 * Boots the real application: AppModule with SharedModule, IdentityModule, the global
 * JwtAuthGuard + PermissionsGuard, AllExceptionsFilter, ResponseInterceptor and ValidationPipe,
 * backed by real Prisma repositories against the throwaway container database.
 *
 * Only the outbound notification transport is replaced. OTP (in-memory), Fayda (mock provider)
 * and the permission caches (in-process) are already the project's non-production adapters and
 * are used as-is, so the wiring under test is the wiring that ships.
 */
export async function createTestApp(
  overrides: TestAppOverride[] = [],
  options: TestAppOptions = {},
): Promise<TestContext> {
  assertTestDatabase(process.env.DATABASE_URL);

  const notifications = new RecordingNotificationAdapter();

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NOTIFICATION_PORT)
    .useValue(notifications);

  for (const override of overrides) {
    const overrideBuilder = builder.overrideProvider(override.provide);
    builder =
      override.useClass !== undefined
        ? overrideBuilder.useClass(override.useClass)
        : overrideBuilder.useValue(override.useValue);
  }

  const moduleRef = await builder.compile();

  // `rawBody: true` mirrors `main.ts`: webhook signatures are computed over the exact received
  // bytes, so the harness must preserve them the same way production does.
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();

  let url: string | null = null;
  if (options.listen) {
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  }

  const prisma = app.get(PrismaService);
  const relay = app.get(OutboxRelay);
  const permissionCache = app.get(PermissionCacheService);
  const permVersions = app.get<CachedPermVersionStore>(PERM_VERSION_STORE);

  return {
    app,
    server: app.getHttpServer() as Server,
    url,
    prisma,
    notifications,
    async drainOutbox() {
      // Loop: a handler may itself write a new event.
      for (let i = 0; i < 5; i += 1) {
        const published = await relay.relayOnce();
        if (published === 0) break;
      }
    },
    async reset() {
      await resetDatabase(prisma);
      notifications.clear();
      // Wiping rows behind a cache's back would otherwise let a previous test's permissions or
      // permVersion satisfy the guard for a brand-new user id.
      permissionCache.clear();
      permVersions.clear();
    },
  };
}

export async function closeTestApp(ctx: TestContext): Promise<void> {
  await ctx.app.close();
}
