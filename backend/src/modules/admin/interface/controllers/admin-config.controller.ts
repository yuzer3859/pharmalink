import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RollbackConfigCommand } from '../../application/commands/rollback-config.command';
import { UpdateConfigCommand } from '../../application/commands/update-config.command';
import { GetConfigQuery } from '../../application/queries/get-config.query';
import {
  ListConfigQueryDto,
  RollbackConfigDto,
  UpdateConfigDto,
} from '../dtos/config.dto';
import {
  ConfigHistoryResponse,
  ConfigResponse,
  UpdateConfigResponse,
  toConfigHistoryResponse,
  toConfigResponse,
  toUpdateConfigResponse,
} from '../dtos/config.response';

/**
 * Platform configuration (module-16 §9.4, FR-ADM-04).
 *
 *     GET  /admin/config                              every governable setting
 *     GET  /admin/config/{namespace}/{key}            one setting, with its effective value
 *     GET  /admin/config/{namespace}/{key}/history    every version ever published
 *     PUT  /admin/config/{namespace}/{key}            publish a new version
 *     POST /admin/config/{namespace}/{key}/rollback   bring an earlier version's value back
 *
 * ## Authorization
 *
 * Every route requires `config:manage:global` — **an existing catalogue key**. It has been in
 * `rbac-catalog.ts` since Phase 0, declared and attached to nothing, waiting for this surface;
 * no permission was invented by this work and no grant was widened.
 *
 * Who holds it is worth stating, because §14 asks for exactly this check: **nobody except
 * `SUPER_ADMIN`**, which holds `'*'`. It is not in the `ADMIN` role's list, so an ordinary
 * administrator — who can suspend users, moderate reviews and read finance reports — cannot change
 * a platform fee or a delivery TTL. `CUSTOMER`, `DRIVER` and `PHARMACY_OWNER` are nowhere near it.
 * That is the design's "config:manage — Super Admin" realised through the catalogue rather than
 * through a check somebody wrote.
 *
 * Reads take the same permission rather than a separate `config:read`. There is no such key in the
 * catalogue, and inventing one would mean inventing the grant to go with it — the wrong order, and
 * the same reasoning Module 08's controllers gave for not creating an admin delivery permission
 * ahead of the surface that needs it. The reads are also not innocuous: the listing enumerates
 * every governable setting and its current value, which is a map of the platform's economics.
 *
 * ## Actor
 *
 * From the verified access token on every mutation, via `@CurrentUser`. No DTO carries an actor
 * field, and `forbidNonWhitelisted` rejects a request that invents one — so an audit entry's actor
 * is always the authenticated principal and never something a body claimed.
 *
 * ## What cannot be reached from here
 *
 * No route can address a key outside `ConfigCatalogue`. A `PUT` naming `TELEBIRR_API_SECRET`,
 * `JWT_ACCESS_SECRET` or `redis.url` fails in `ConfigKey.of` with `NOT_FOUND` before validation,
 * before a transaction and before anything is written — and answers identically to a key that is
 * simply misspelled, so the route cannot be used to discover which secrets exist. §18's "not a
 * generic secret store" is a property of the catalogue, not a filter applied here.
 *
 * Errors are not caught — the global filter maps them: `NOT_FOUND` (404) for an ungovernable key or
 * a missing rollback target, `CONFIG_VALIDATION_FAILED` (422) for a value the owning module
 * refuses, `CONFLICT` (409) for a lost version race, `RBAC_FORBIDDEN` (403) for an unentitled
 * caller.
 */
@Controller('admin/config')
export class AdminConfigController {
  constructor(
    private readonly read: GetConfigQuery,
    private readonly update: UpdateConfigCommand,
    private readonly rollback: RollbackConfigCommand,
  ) {}

  /**
   * Every setting an administrator may govern, with what is in force and where it came from.
   *
   * Built from the catalogue, so it lists settings nobody has ever changed — which is the useful
   * answer to "what can I configure?" and also makes the governable surface visible in the product.
   */
  @Get()
  @RequirePermissions('config:manage:global')
  async list(@Query() query: ListConfigQueryDto): Promise<ConfigResponse[]> {
    const views = await this.read.execute(query.namespace);
    return views.map(toConfigResponse);
  }

  /** One setting. `404` when the key is not governable. */
  @Get(':namespace/:key')
  @RequirePermissions('config:manage:global')
  async getOne(
    @Param('namespace') namespace: string,
    @Param('key') key: string,
  ): Promise<ConfigResponse> {
    return toConfigResponse(await this.read.byKey(namespace, key));
  }

  /**
   * Every version ever published for one setting, newest first.
   *
   * Declared **after** `:namespace/:key` but on a longer path, so there is no ambiguity: Nest
   * matches on segment count first, and `history` is a third segment rather than a key that could
   * be mistaken for one.
   */
  @Get(':namespace/:key/history')
  @RequirePermissions('config:manage:global')
  async history(
    @Param('namespace') namespace: string,
    @Param('key') key: string,
  ): Promise<ConfigHistoryResponse> {
    return toConfigHistoryResponse(await this.read.history(namespace, key));
  }

  /**
   * Publishes a new version.
   *
   * `PUT`, and the design names it so, but the semantics are append-only underneath: this never
   * overwrites the version it replaces, it writes the next one and moves which is active. The
   * response carries both, so the caller can see exactly what changed without a second read.
   */
  @Put(':namespace/:key')
  @RequirePermissions('config:manage:global')
  async put(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('namespace') namespace: string,
    @Param('key') key: string,
    @Body() body: UpdateConfigDto,
  ): Promise<UpdateConfigResponse> {
    return toUpdateConfigResponse(
      await this.update.execute({
        // From the token. There is no DTO field through which an actor could arrive.
        actorUserId: user.userId,
        namespace,
        key,
        valueType: body.valueType,
        value: body.value,
        reason: body.reason ?? null,
      }),
    );
  }

  /**
   * Brings an earlier version's value back into force as a **new** version.
   *
   * `200`, not `201`: the response is the setting's new state, and the thing created is a version
   * the caller addresses by number rather than by a location header. The old version is re-validated
   * on the way through, so a value the owning module would no longer accept cannot return silently.
   */
  @Post(':namespace/:key/rollback')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('config:manage:global')
  async rollbackTo(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('namespace') namespace: string,
    @Param('key') key: string,
    @Body() body: RollbackConfigDto,
  ): Promise<UpdateConfigResponse> {
    return toUpdateConfigResponse(
      await this.rollback.execute({
        actorUserId: user.userId,
        namespace,
        key,
        toVersion: body.toVersion,
        reason: body.reason ?? null,
      }),
    );
  }
}
