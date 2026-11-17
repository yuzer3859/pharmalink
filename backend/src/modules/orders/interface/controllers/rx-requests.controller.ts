import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RxRequestCommands } from '../../application/commands/rx-request.commands';
import { RxRequestQuoteCommands } from '../../application/commands/rx-request-quote.commands';
import { RxRequestQueries } from '../../application/queries/rx-request.queries';
import {
  ConfirmRxRequestDto,
  CreateRxRequestDto,
  QuoteRxRequestDto,
  DeclineRxRequestDto,
  PharmacyRxRequestListDto,
  ReleaseRxRequestDto,
  RxRequestPageDto,
} from '../dtos/rx-request.dto';

/**
 * Work 134 (owner decision 2026-11-17): the customer's prescription requests. The prescription is
 * uploaded first (`POST /prescriptions/uploads`, then `POST /prescriptions`); sending it offers it
 * to the eligible pharmacies near the delivery address.
 */
@Controller('rx-requests')
export class RxRequestsController {
  constructor(
    private readonly commands: RxRequestCommands,
    private readonly quotes: RxRequestQuoteCommands,
    private readonly queries: RxRequestQueries,
  ) {}

  /**
   * Work 135: the customer accepts the pharmacy's quote; it becomes an order at that pharmacy.
   * Answers the request and the new order's id. A declined prepayment answers
   * `PAYMENT_AUTH_FAILED` with the cancelled order's id, as checkout does.
   */
  @Post(':id/confirm')
  @RequirePermissions('order:create:own')
  @HttpCode(HttpStatus.OK)
  async confirm(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmRxRequestDto) {
    const { orderId } = await this.quotes.confirm({ requestId: id, customerUserId: user.userId, payment: dto.payment });
    return { request: await this.queries.getMine(user.userId, id), orderId };
  }

  @Post(':id/decline-quote')
  @RequirePermissions('prescription:upload:own')
  @HttpCode(HttpStatus.OK)
  async declineQuote(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.quotes.declineQuote({ requestId: id, customerUserId: user.userId });
    return this.queries.getMine(user.userId, id);
  }

  @Post()
  @RequirePermissions('prescription:upload:own')
  async create(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: CreateRxRequestDto) {
    const created = await this.commands.create({
      customerUserId: user.userId,
      prescriptionId: dto.prescriptionId,
      addressId: dto.addressId,
      prescriptionIssueDate: new Date(`${dto.prescriptionIssueDate.slice(0, 10)}T00:00:00.000Z`),
      note: dto.note ?? null,
    });
    return this.queries.getMine(user.userId, created.id);
  }

  @Get()
  @RequirePermissions('prescription:read:own')
  list(@CurrentUser() user: AuthenticatedPrincipal, @Query() query: RxRequestPageDto) {
    return this.queries.listMine(user.userId, query.page, query.size);
  }

  @Get(':id')
  @RequirePermissions('prescription:read:own')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.queries.getMine(user.userId, id);
  }

  @Post(':id/cancel')
  @RequirePermissions('prescription:upload:own')
  @HttpCode(HttpStatus.OK)
  async cancel(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.commands.cancel({ requestId: id, customerUserId: user.userId });
    return this.queries.getMine(user.userId, id);
  }
}

/**
 * Work 134: the requests offered to the caller's pharmacies. Any staff member with
 * `order:fulfill:org` sees them, with the customer's name only; deciding — opening the file,
 * accepting, declining, letting go — needs `prescription:verify` and the PHARMACIST role at the
 * pharmacy the request was offered to, checked below this boundary. No route takes a pharmacy id.
 */
@Controller('pharmacy/rx-requests')
export class PharmacyRxRequestsController {
  constructor(
    private readonly commands: RxRequestCommands,
    private readonly quotes: RxRequestQuoteCommands,
    private readonly queries: RxRequestQueries,
  ) {}

  /** Work 135: the holding pharmacy's medicines, price and paper decision, for the customer to confirm. */
  @Post(':id/quote')
  @RequirePermissions('prescription:verify')
  @HttpCode(HttpStatus.OK)
  async quote(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteRxRequestDto) {
    await this.quotes.quote({
      requestId: id,
      actorUserId: user.userId,
      lines: dto.lines,
      prescriptionIssueDate: new Date(`${dto.prescriptionIssueDate.slice(0, 10)}T00:00:00.000Z`),
      paperRequired: dto.paperRequired,
      legibilityOk: dto.legibilityOk,
      validityOk: dto.validityOk,
      note: dto.note ?? null,
    });
    return this.queries.getForPharmacy(user.userId, id);
  }

  @Get()
  @RequirePermissions('order:fulfill:org')
  list(@CurrentUser() user: AuthenticatedPrincipal, @Query() query: PharmacyRxRequestListDto) {
    return this.queries.listForPharmacy(user.userId, query.scope, query.page, query.size);
  }

  @Get(':id')
  @RequirePermissions('order:fulfill:org')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.queries.getForPharmacy(user.userId, id);
  }

  @Post(':id/file')
  @RequirePermissions('prescription:verify')
  @HttpCode(HttpStatus.OK)
  file(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    return this.queries.fileLink(user.userId, id, ip);
  }

  /** First acceptance wins; a later one answers `409 RX_REQUEST_UNAVAILABLE`. */
  @Post(':id/accept')
  @RequirePermissions('prescription:verify')
  @HttpCode(HttpStatus.OK)
  async accept(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.commands.accept({ requestId: id, actorUserId: user.userId });
    return this.queries.getForPharmacy(user.userId, id);
  }

  @Post(':id/decline')
  @RequirePermissions('prescription:verify')
  @HttpCode(HttpStatus.OK)
  async decline(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeclineRxRequestDto) {
    await this.commands.decline({ requestId: id, actorUserId: user.userId, reason: dto.reason });
    return this.queries.getForPharmacy(user.userId, id);
  }

  /** The accepting pharmacy cannot fill it after all: it is offered to the others again. */
  @Post(':id/release')
  @RequirePermissions('prescription:verify')
  @HttpCode(HttpStatus.OK)
  async release(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseRxRequestDto) {
    await this.commands.release({ requestId: id, actorUserId: user.userId, reason: dto.reason });
    return this.queries.getForPharmacy(user.userId, id);
  }
}
