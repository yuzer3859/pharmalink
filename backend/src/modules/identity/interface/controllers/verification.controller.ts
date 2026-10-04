import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { SubmitFaydaVerificationCommand } from '../../application/commands/submit-fayda-verification.command';
import { SubmitVerificationDocumentsCommand } from '../../application/commands/submit-verification-documents.command';
import { GetVerificationStatusQuery } from '../../application/queries/get-verification-status.query';
import { CurrentUser } from '../decorators/current-user.decorator';
import { SubmitDocumentsDto, SubmitFaydaDto } from '../dtos/verification.dto';

/** Self-service verification (module-01 §11.6). Authenticated; no extra permission required. */
@Controller('verification')
export class VerificationController {
  constructor(
    private readonly submitFayda: SubmitFaydaVerificationCommand,
    private readonly submitDocuments: SubmitVerificationDocumentsCommand,
    private readonly getStatus: GetVerificationStatusQuery,
  ) {}

  @Post('fayda')
  @HttpCode(HttpStatus.ACCEPTED)
  fayda(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: SubmitFaydaDto,
    @Req() req: Request,
  ) {
    return this.submitFayda.execute({
      userId: user.userId,
      faydaId: dto.faydaId,
      consentGranted: dto.consentGranted,
      fullName: dto.fullName ?? null,
      dateOfBirth: dto.dateOfBirth ?? null,
      organizationId: dto.organizationId ?? null,
      ip: req.ip ?? null,
    });
  }

  @Post('documents')
  @HttpCode(HttpStatus.ACCEPTED)
  documents(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: SubmitDocumentsDto,
    @Req() req: Request,
  ) {
    return this.submitDocuments.execute({
      userId: user.userId,
      type: dto.type,
      organizationId: dto.organizationId ?? null,
      documents: dto.documents.map((d) => ({
        kind: d.kind,
        storageRef: d.storageRef,
        expiresAt: d.expiresAt ?? null,
      })),
      ip: req.ip ?? null,
    });
  }

  @Get('status')
  status(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.getStatus.execute(user.userId);
  }
}
