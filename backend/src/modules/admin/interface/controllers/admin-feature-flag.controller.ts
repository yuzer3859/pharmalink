import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ToggleFeatureFlagCommand } from '../../application/commands/toggle-feature-flag.command';
import { GetFeatureFlagsQuery } from '../../application/queries/get-feature-flags.query';
import { ToggleFeatureFlagDto } from '../dtos/config.dto';
import {
  FeatureFlagResponse,
  ToggleFeatureFlagResponse,
  toFeatureFlagResponse,
  toToggleFeatureFlagResponse,
} from '../dtos/config.response';

/**
 * Feature flags (module-16 §9.4, F-AD-13).
 *
 *     GET /admin/feature-flags          every flag that has been administered
 *     PUT /admin/feature-flags/{key}    turn one on or off
 *
 * ## Authorization
 *
 * `config:manage:global`, the same existing catalogue key the configuration routes use, held by
 * `SUPER_ADMIN` alone. A flag decides whether a capability exists for the whole platform — turning
 * COD off is a larger act than changing its threshold — so governing it under a weaker permission
 * than the settings beside it would be the wrong way round.
 *
 * ## A separate controller, same prefix family
 *
 * Flags and configuration are different aggregates with different lifecycles: a config version is
 * immutable and accumulates history, a flag is a switch whose history lives in the audit log. They
 * share a permission and an audience, not a model, and keeping them in separate files is the same
 * separation the tables have.
 *
 * ## What a missing flag means here
 *
 * `GET` lists what has been **administered**, which is not the same as what exists — a flag nobody
 * has touched has no row and does not appear. It is not therefore disabled: the resolver falls back
 * to the environment's `FEATURE_<KEY>` check, so an untouched flag behaves exactly as it did before
 * this module existed. The first `PUT` on a key is what brings it under administration.
 */
@Controller('admin/feature-flags')
export class AdminFeatureFlagController {
  constructor(
    private readonly read: GetFeatureFlagsQuery,
    private readonly toggle: ToggleFeatureFlagCommand,
  ) {}

  @Get()
  @RequirePermissions('config:manage:global')
  async list(): Promise<FeatureFlagResponse[]> {
    const views = await this.read.execute();
    return views.map(toFeatureFlagResponse);
  }

  /**
   * Turns a flag on or off, creating it if this is the first time it has been administered.
   *
   * Idempotent: a `PUT` that asks for the state the flag already holds writes nothing — no row, no
   * audit entry, no event — and answers `changed: false`. Recording a decision nobody took would
   * fill the audit trail with noise precisely where it needs to be readable.
   */
  @Put(':key')
  @RequirePermissions('config:manage:global')
  async put(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('key') key: string,
    @Body() body: ToggleFeatureFlagDto,
  ): Promise<ToggleFeatureFlagResponse> {
    return toToggleFeatureFlagResponse(
      await this.toggle.execute({
        // From the token, never from the body.
        actorUserId: user.userId,
        key,
        enabled: body.enabled,
        description: body.description,
      }),
    );
  }
}
