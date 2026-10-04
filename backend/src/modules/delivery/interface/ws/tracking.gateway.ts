import { Inject } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { PublishJobLocationCommand } from '../../application/commands/publish-job-location.command';
import {
  GetJobTrackingQuery,
  JobTrackingView,
  TrackingViewer,
} from '../../application/queries/get-job-tracking.query';
import {
  IRealtimePort,
  REALTIME_PORT,
  RealtimeUnsubscribe,
  TrackingUpdate,
} from '../../application/ports/outbound/realtime.port';
import { toEtaResponse } from '../dtos/tracking.response';
import { WsAuthService } from './ws-auth.service';

/**
 * The permission a customer needs to watch their own delivery.
 *
 * `order:read:own`, which has been granted to `CUSTOMER` since Phase 0. **No new permission is
 * invented for tracking**, and that is the honest mapping rather than a convenient one: watching
 * where your medicines are is reading your own order. A `delivery:read:own` key would describe the
 * same act in different words and would have to be granted to exactly the same role, leaving the
 * catalogue with two names for one authority — and every deployment with a migration to write
 * before any customer could track anything.
 */
export const TRACKING_SUBSCRIBE_PERMISSION = 'order:read:own';

/**
 * The permission a driver needs to post a position.
 *
 * `delivery:update:own`, the same key the six status routes take. Reporting where you are on a job
 * you are carrying is updating your own delivery, which is precisely what it says.
 */
export const TRACKING_PUBLISH_PERMISSION = 'delivery:update:own';

/** Inbound message names. Narrow and explicit — anything else is ignored by socket.io. */
export const TRACKING_EVENTS = {
  subscribe: 'tracking:subscribe',
  unsubscribe: 'tracking:unsubscribe',
  location: 'tracking:location',
} as const;

/** Outbound message names. */
export const TRACKING_SERVER_EVENTS = {
  /** The snapshot sent on a successful subscribe, and again on any resubscribe. */
  snapshot: 'tracking:snapshot',
  /** A live position. Payload is exactly `TrackingUpdate`. */
  update: 'tracking:update',
  /** A connection-level failure. The socket is closed immediately after. */
  error: 'tracking:error',
} as const;

/** What every acknowledged message returns. Mirrors the HTTP error envelope's shape, not its body. */
interface Ack<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** Per-socket transport state. Explicitly *not* business state — see the class comment. */
interface SocketState {
  principal: AuthenticatedPrincipal;
  /** jobId -> the release for that job's fan-out subscription. */
  subscriptions: Map<string, RealtimeUnsubscribe>;
}

/**
 * `TrackingGateway` (§3.4 F-TRK-01/F-TRK-03, §7, §9.4, §10's `interface/ws/`, BR-DEL-05,
 * NFR-PERF-04, NFR-LOC-04) — the live tracking channel.
 *
 * Namespaced `/tracking`, matching §9's `/api/v1/tracking (WS)` base path.
 *
 * ## Three messages, and every one of them re-authorizes
 *
 * `tracking:subscribe` takes `{ jobId }` or `{ orderId }` and starts a stream;
 * `tracking:unsubscribe` stops one; `tracking:location` is the driver posting a fix. All three
 * acknowledge, so a client gets a real answer rather than inferring success from silence.
 *
 * Authentication happens once at connect, but **authorization happens on every message**, against
 * current data, through the same `GetJobTrackingQuery` the HTTP fallback uses. That is not
 * belt-and-braces; it is the only thing that makes a long-lived connection safe. A socket opened
 * while a driver held a job must stop serving that job the moment they are reassigned off it, and
 * a check performed only at subscribe time would keep streaming a customer's address to somebody
 * who lost the delivery an hour ago. Re-checking costs an indexed read per message and removes an
 * entire class of stale-authorization bug.
 *
 * ## The socket knows nothing that matters
 *
 * Per-socket state is a principal and a map of unsubscribe handles: transport bookkeeping, with no
 * business fact in it. Every decision — who owns this order, who is carrying this job, what state
 * it is in, where the driver was — is read from Postgres or from the shared cache at the moment it
 * is needed. §7's requirement that a node hold no correctness-critical per-client state is
 * therefore satisfied structurally: a node that dies loses sockets, and the clients that reconnect
 * elsewhere are served identically because there was nothing on the old node to lose.
 *
 * Reconnection needs no special handling for the same reason. A reconnecting client is a new
 * socket that authenticates, subscribes and is handed a fresh snapshot from the durable record —
 * §7's "must not require creating duplicate persistent subscriptions" holds because a disconnect
 * releases everything the socket held, and the Redis channel's reference count falls with it.
 *
 * ## What a client is told when things go wrong
 *
 * Failures are acknowledged with the platform's own `ErrorCode`, so a socket client and an HTTP
 * client see the same vocabulary for the same refusal. An unauthorized subscribe gets `NOT_FOUND`,
 * exactly as the HTTP route does — a distinguishable "exists but not yours" would turn job and
 * order ids into an oracle for who has ordered medicines and when.
 *
 * Nothing here throws into socket.io's error path. An exception escaping a message handler
 * terminates the connection, which for a tracking client means a reconnect storm on the back of a
 * single bad request; every handler catches and answers instead.
 */
@WebSocketGateway({
  namespace: 'tracking',
  // The customer app is a browser client on a different origin. Mirrors `main.ts`'s CORS decision
  // rather than inventing a second policy: the socket carries the same bearer token as the REST
  // API and must be reachable from the same places.
  cors: { origin: true, credentials: true },
})
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly sockets = new Map<string, SocketState>();

  constructor(
    private readonly auth: WsAuthService,
    private readonly tracking: GetJobTrackingQuery,
    private readonly publishLocation: PublishJobLocationCommand,
    @Inject(REALTIME_PORT) private readonly realtime: IRealtimePort,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(TrackingGateway.name);
  }

  async handleConnection(client: Socket): Promise<void> {
    const state = await this.stateFor(client);
    if (state === null) {
      // Told, then closed. A client that cannot tell "rejected" from "network died" retries in a
      // tight loop; one message costs nothing and prevents that.
      client.emit(TRACKING_SERVER_EVENTS.error, {
        code: ErrorCode.UNAUTHENTICATED,
        message: 'Authentication required.',
      });
      client.disconnect(true);
    }
  }

  /**
   * The socket's authenticated state, established on first need and memoised.
   *
   * **Not** simply read from a map `handleConnection` filled, and the difference is a real bug
   * rather than a stylistic one. socket.io tells the client it is connected as soon as the
   * namespace accepts it, which is before this gateway's `handleConnection` has finished awaiting
   * the token check — so a client that connects and immediately sends its first message can arrive
   * while that check is still in flight. Reading a not-yet-populated map would answer
   * `UNAUTHENTICATED` to a perfectly valid request, and the clients most likely to hit it are the
   * ones that open a socket in order to send something.
   *
   * Resolving the principal here instead removes the ordering dependency altogether: whichever of
   * the connection handler and the first message gets here first does the work, and the other
   * finds it done. Authentication still happens exactly once per socket.
   */
  private async stateFor(client: Socket): Promise<SocketState | null> {
    const existing = this.sockets.get(client.id);
    if (existing) {
      return existing;
    }

    const principal = await this.auth.authenticate(client.handshake);
    if (principal === null) {
      return null;
    }

    // Two messages can race into the await above; the first to return wins, and both then share
    // one subscription map. Without this the loser would overwrite the winner's map and leak
    // every subscription already recorded in it.
    const raced = this.sockets.get(client.id);
    if (raced) {
      return raced;
    }

    const state: SocketState = { principal, subscriptions: new Map() };
    this.sockets.set(client.id, state);
    return state;
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const state = this.sockets.get(client.id);
    this.sockets.delete(client.id);
    if (!state) {
      return;
    }
    // Release every fan-out subscription this socket held. Without this the Redis channel's
    // reference count never reaches zero and the node keeps receiving a delivery's positions long
    // after anybody here is watching.
    await Promise.all(
      [...state.subscriptions.values()].map((release) =>
        release().catch((err: Error) =>
          this.logger.warn(`Failed to release a tracking subscription: ${err.message}`),
        ),
      ),
    );
    state.subscriptions.clear();
  }

  @SubscribeMessage(TRACKING_EVENTS.subscribe)
  async onSubscribe(client: Socket, payload: unknown): Promise<Ack<JobTrackingView>> {
    return this.handle(client, async (state) => {
      const target = readSubscribeTarget(payload);

      // Authorization and the snapshot in one call, so there is no window in which a client is
      // subscribed but not yet known to be allowed. `NOT_FOUND` for anybody who is neither the
      // owning customer nor the assigned driver.
      const { view, viewer } = target.jobId
        ? await this.tracking.byJobId(target.jobId, state.principal.userId)
        : await this.tracking.byOrderId(target.orderId as string, state.principal.userId);

      // A driver watching their own job needs no `order:read:own` — they are not reading an order.
      // A customer does, and is refused without it.
      if (
        viewer === TrackingViewer.Customer &&
        !this.auth.can(state.principal, TRACKING_SUBSCRIBE_PERMISSION)
      ) {
        throw ApiException.forbidden('You may not track this delivery.');
      }

      const existing = state.subscriptions.get(view.jobId);
      if (existing === undefined) {
        const release = await this.streamTo(client, view.jobId);
        state.subscriptions.set(view.jobId, release);
      }
      // A resubscribe to a job the socket already follows is answered with a fresh snapshot and
      // no second stream. That is what makes a client's reconnect-and-resubscribe loop safe, and
      // it is also how a client asks "where are they now?" without opening anything new.

      client.emit(TRACKING_SERVER_EVENTS.snapshot, toWire(view));
      return view;
    });
  }

  @SubscribeMessage(TRACKING_EVENTS.unsubscribe)
  async onUnsubscribe(client: Socket, payload: unknown): Promise<Ack<{ jobId: string }>> {
    return this.handle(client, async (state) => {
      const jobId = readJobId(payload);
      const release = state.subscriptions.get(jobId);
      if (release) {
        state.subscriptions.delete(jobId);
        await release();
      }
      // Unsubscribing from something you were not subscribed to succeeds. It is the state the
      // caller asked for, and a client tidying up after a reconnect should not have to remember
      // what the previous socket held.
      return { jobId };
    });
  }

  @SubscribeMessage(TRACKING_EVENTS.location)
  async onLocation(
    client: Socket,
    payload: unknown,
  ): Promise<Ack<{ accepted: boolean; persisted: boolean; published: boolean }>> {
    return this.handle(client, async (state) => {
      if (!this.auth.can(state.principal, TRACKING_PUBLISH_PERMISSION)) {
        // A customer's token cannot post positions, even for their own delivery.
        throw ApiException.forbidden('You may not publish a delivery location.');
      }

      const fix = readLocation(payload);
      const result = await this.publishLocation.execute({
        // From the authenticated principal, never from the message. The payload has no field
        // through which a driver id could arrive.
        userId: state.principal.userId,
        jobId: fix.jobId,
        lat: fix.lat,
        lng: fix.lng,
        recordedAt: fix.recordedAt,
      });

      return {
        accepted: result.accepted,
        persisted: result.persisted,
        published: result.published,
      };
    });
  }

  /**
   * Wires a job's fan-out to this socket.
   *
   * The listener emits and does nothing else. It performs no authorization: the subscription was
   * authorized when it was created and is released the moment the socket closes, and re-checking
   * per *message* would put a database read on the path of every driver's every fix for every
   * watcher — the one place in this design where that cost is not affordable. What bounds the
   * exposure instead is that the stream carries only a position (`TrackingUpdate` is the whole
   * contract) and that a client must re-subscribe, and so be re-authorized, on every reconnect.
   */
  private async streamTo(client: Socket, jobId: string): Promise<RealtimeUnsubscribe> {
    return this.realtime.subscribe(jobId, (update: TrackingUpdate) => {
      client.emit(TRACKING_SERVER_EVENTS.update, update);
    });
  }

  /**
   * Runs a handler with the socket's state, turning every failure into an acknowledged error.
   *
   * The `ApiException` mapping is what keeps the socket API and the REST API speaking one
   * language. Anything else is logged and reported as `INTERNAL_ERROR` with no detail — an
   * exception message can carry an id, a query fragment or a stack, and none of that belongs on a
   * customer's socket.
   */
  private async handle<T>(
    client: Socket,
    run: (state: SocketState) => Promise<T>,
  ): Promise<Ack<T>> {
    const state = await this.stateFor(client);
    if (!state) {
      // No usable token: malformed, expired, or minted before a permission change.
      return fail(ErrorCode.UNAUTHENTICATED, 'Authentication required.');
    }
    try {
      return { ok: true, data: await run(state) };
    } catch (err) {
      if (err instanceof ApiException) {
        return fail(err.code, err.message);
      }
      this.logger.error(`Tracking message failed: ${(err as Error).message}`);
      return fail(ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
  }
}

function fail<T>(code: string, message: string): Ack<T> {
  return { ok: false, error: { code, message } };
}

/** The snapshot as it goes over the wire — dates as ISO strings, and nothing added. */
function toWire(view: JobTrackingView): Record<string, unknown> {
  return {
    jobId: view.jobId,
    orderId: view.orderId,
    fulfillmentId: view.fulfillmentId,
    status: view.status,
    isLive: view.isLive,
    isFinished: view.isFinished,
    location:
      view.location === null
        ? null
        : {
            lat: view.location.lat,
            lng: view.location.lng,
            recordedAt: view.location.recordedAt.toISOString(),
          },
    // The REST mapper's own function, not a copy of it. The socket snapshot and the HTTP fallback
    // are asserted byte-for-byte equal in the e2e suite, and sharing the mapper is what makes that
    // hold by construction rather than by two authors agreeing.
    eta: toEtaResponse(view.eta),
  };
}

/**
 * Message validation.
 *
 * Hand-written rather than delegated to the global `ValidationPipe`, and deliberately so. That
 * pipe's failure mode is an exception, which on a gateway means socket.io tears the connection
 * down — so a single malformed frame from a buggy client would disconnect it, and it would
 * reconnect, and send the frame again. These functions throw `ApiException`s that `handle` turns
 * into an acknowledged `VALIDATION_ERROR`, leaving the connection up and the client able to see
 * what it got wrong. Unknown fields are simply not read; there is no path by which one reaches a
 * command.
 */
function asRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw ApiException.validation('Message payload must be an object.');
  }
  return payload as Record<string, unknown>;
}

function readSubscribeTarget(payload: unknown): { jobId?: string; orderId?: string } {
  const body = asRecord(payload);
  const jobId = optionalText(body.jobId, 'jobId');
  const orderId = optionalText(body.orderId, 'orderId');
  if (jobId === null && orderId === null) {
    throw ApiException.validation('Provide either jobId or orderId.');
  }
  if (jobId !== null && orderId !== null) {
    // Refused rather than silently preferring one. Two identifiers that disagree is a client bug,
    // and picking a winner would hide it behind a subscription to the wrong delivery.
    throw ApiException.validation('Provide jobId or orderId, not both.');
  }
  return jobId !== null ? { jobId } : { orderId: orderId as string };
}

function readJobId(payload: unknown): string {
  const body = asRecord(payload);
  const jobId = optionalText(body.jobId, 'jobId');
  if (jobId === null) {
    throw ApiException.validation('jobId is required.');
  }
  return jobId;
}

function readLocation(payload: unknown): {
  jobId: string;
  lat: number;
  lng: number;
  recordedAt: Date | undefined;
} {
  const body = asRecord(payload);
  const jobId = readJobId(body);

  if (typeof body.lat !== 'number' || !Number.isFinite(body.lat)) {
    throw ApiException.validation('lat must be a finite number.', { field: 'lat' });
  }
  if (typeof body.lng !== 'number' || !Number.isFinite(body.lng)) {
    throw ApiException.validation('lng must be a finite number.', { field: 'lng' });
  }

  // Range is checked by `GeoPoint` and clock skew by the driver-profile aggregate — both inside
  // the command, so the socket and the HTTP route cannot end up with different notions of a valid
  // coordinate. This only rejects what is not a number at all.
  return { jobId, lat: body.lat, lng: body.lng, recordedAt: optionalDate(body.recordedAt) };
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw ApiException.validation(`${field} must be a string.`, { field });
  }
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function optionalDate(value: unknown): Date | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw ApiException.validation('recordedAt must be an ISO-8601 string.', {
      field: 'recordedAt',
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw ApiException.validation('recordedAt must be a valid date.', { field: 'recordedAt' });
  }
  return date;
}
