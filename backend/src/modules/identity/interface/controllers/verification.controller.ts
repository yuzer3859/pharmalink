import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { SensitiveRateLimit } from '../../../../shared/http/rate-limit.decorator';
import type { Request } from 'express';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { SubmitFaydaVerificationCommand } from '../../application/commands/submit-fayda-verification.command';
import { RequestDocumentUploadCommand } from '../../application/commands/request-document-upload.command';
import { SubmitVerificationDocumentsCommand } from '../../application/commands/submit-verification-documents.command';
import { GetVerificationStatusQuery } from '../../application/queries/get-verification-status.query';
import { CurrentUser } from '../decorators/current-user.decorator';
import { RequestDocumentUploadDto, SubmitDocumentsDto, SubmitFaydaDto } from '../dtos/verification.dto';

/** Self-service verification (module-01 §11.6). Authenticated; no extra permission required. */
@Controller('verification')
export class VerificationController {
  constructor(
    private readonly submitFayda: SubmitFaydaVerificationCommand,
    private readonly submitDocuments: SubmitVerificationDocumentsCommand,
    private readonly getStatus: GetVerificationStatusQuery,
    private readonly requestUpload: RequestDocumentUploadCommand,
  ) {}

  @SensitiveRateLimit()
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

  /**
   * Work 89: a signed link to upload one document straight to storage. The returned `storageRef`
   * then goes into `POST /verification/documents`. Bytes never pass through this API.
   */
  @SensitiveRateLimit()
  @Post('documents/uploads')
  @HttpCode(HttpStatus.CREATED)
  async upload(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: RequestDocumentUploadDto, @Req() req: Request) {
    const result = await this.requestUpload.execute({ userId: user.userId, contentType: dto.contentType, bytes: dto.bytes, ip: req.ip ?? null });
    return { storageRef: result.storageRef, upload: { ...result.upload, expiresAt: result.upload.expiresAt.toISOString() } };
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
