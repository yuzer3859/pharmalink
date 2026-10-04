import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { FindMatchCommand } from '../../application/commands/find-match.command';
import { RematchCommand } from '../../application/commands/rematch.command';
import { SelectMatchCommand } from '../../application/commands/select-match.command';
import { GetMatchResultQuery } from '../../application/queries/get-match-result.query';
import { FindMatchDto, RematchDto, SelectMatchDto } from '../dtos/matching.dto';

/**
 * Availability-based pharmacy matching (customer — `matching:create:own`/`matching:read:own`,
 * module-05 §10.3, §7.3). Ranking, inventory reservation, and the ADR-014 two-transaction
 * ordering all live below this boundary (`FindMatchCommand`/`SelectMatchCommand`/
 * `RematchCommand`) — this controller only translates HTTP <-> command input/output.
 */
@Controller('matching')
export class MatchingController {
  constructor(
    private readonly findMatch: FindMatchCommand,
    private readonly selectMatch: SelectMatchCommand,
    private readonly rematch: RematchCommand,
    private readonly getMatchResult: GetMatchResultQuery,
  ) {}

  @Post('find')
  @RequirePermissions('matching:create:own')
  find(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: FindMatchDto) {
    return this.findMatch.execute({
      customerUserId: user.userId,
      lines: dto.lines,
      deliveryLat: dto.deliveryLat,
      deliveryLng: dto.deliveryLng,
    });
  }

  @Get(':id')
  @RequirePermissions('matching:read:own')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.getMatchResult.execute({ matchRequestId: id, customerUserId: user.userId });
  }

  @Post(':id/select')
  @RequirePermissions('matching:create:own')
  @HttpCode(HttpStatus.OK)
  select(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: SelectMatchDto,
  ) {
    return this.selectMatch.execute({
      matchRequestId: id,
      customerUserId: user.userId,
      pharmacyId: dto.pharmacyId,
      lines: dto.lines,
    });
  }

  @Post(':id/rematch')
  @RequirePermissions('matching:create:own')
  @HttpCode(HttpStatus.OK)
  rematchMatch(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: RematchDto,
  ) {
    return this.rematch.execute({
      matchRequestId: id,
      customerUserId: user.userId,
      lines: dto.lines,
    });
  }
}
