import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ReuploadPrescriptionCommand } from '../../application/commands/reupload-prescription.command';
import { UploadPrescriptionCommand } from '../../application/commands/upload-prescription.command';
import { GetPrescriptionQuery } from '../../application/queries/get-prescription.query';
import { ListPrescriptionsQuery } from '../../application/queries/list-prescriptions.query';
import { ListPrescriptionsQueryDto, ReuploadPrescriptionDto, UploadPrescriptionDto } from '../dtos/prescription.dto';

/**
 * Prescriptions (customer — `prescription:upload:own`/`prescription:read:own`, module-05 §10.1,
 * §7.3). Thin HTTP adapter: DTO -> command/query -> response. Ownership, state-transition
 * validity, and access logging all live in the application layer
 * (`UploadPrescriptionCommand`/`ReuploadPrescriptionCommand`/`GetPrescriptionQuery`/
 * `ListPrescriptionsQuery`), never duplicated here.
 */
@Controller('prescriptions')
export class PrescriptionController {
  constructor(
    private readonly uploadPrescription: UploadPrescriptionCommand,
    private readonly reuploadPrescription: ReuploadPrescriptionCommand,
    private readonly getPrescription: GetPrescriptionQuery,
    private readonly listPrescriptions: ListPrescriptionsQuery,
  ) {}

  @Post()
  @RequirePermissions('prescription:upload:own')
  upload(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: UploadPrescriptionDto) {
    return this.uploadPrescription.execute({
      customerUserId: user.userId,
      fileRef: dto.fileRef,
      encryptionKeyRef: dto.encryptionKeyRef,
      fileType: dto.fileType,
      beneficiaryId: dto.beneficiaryId,
      doctorName: dto.doctorName,
      hospitalName: dto.hospitalName,
      issueDate: dto.issueDate ? new Date(dto.issueDate) : undefined,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
    });
  }

  @Get()
  @RequirePermissions('prescription:read:own')
  list(@CurrentUser() user: AuthenticatedPrincipal, @Query() query: ListPrescriptionsQueryDto) {
    return this.listPrescriptions.execute({
      customerUserId: user.userId,
      status: query.status,
      page: query.page ?? 1,
      size: query.size ?? 20,
    });
  }

  @Get(':id')
  @RequirePermissions('prescription:read:own')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.getPrescription.execute({ prescriptionId: id, requestingUserId: user.userId });
  }

  @Post(':id/reupload')
  @RequirePermissions('prescription:upload:own')
  @HttpCode(HttpStatus.OK)
  reupload(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body() dto: ReuploadPrescriptionDto,
  ) {
    return this.reuploadPrescription.execute({
      prescriptionId: id,
      customerUserId: user.userId,
      fileRef: dto.fileRef,
      encryptionKeyRef: dto.encryptionKeyRef,
      fileType: dto.fileType,
    });
  }
}
