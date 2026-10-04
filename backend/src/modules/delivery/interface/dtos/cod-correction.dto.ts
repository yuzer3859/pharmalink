import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import {
  MAX_CORRECTION_IDEMPOTENCY_KEY_LENGTH,
  MAX_CORRECTION_REASON_LENGTH,
  MAX_CORRECTION_REFERENCE_LENGTH,
  MIN_CORRECTION_IDEMPOTENCY_KEY_LENGTH,
} from '../../domain/entities/cod-correction.entity';
import { CodCorrectionType } from '../../domain/enums';

const MAX_ID_LENGTH = 64;

/**
 * `POST /admin/delivery/cod-reconciliation/:collectionId/corrections` (§1, §2, §4).
 *
 * ## What an operator may state
 *
 * The record being corrected, the kind of mistake, the value pair its kind calls for, a reason, and
 * a replay key. That is all, and the omissions are the design:
 *
 *  - **No `collectedAmount`, `expectedAmount`, `remittedAmount`, `method`, `status` or timestamp.**
 *    `forbidNonWhitelisted` turns sending any of them into a `400`, so a correction request cannot
 *    even appear to edit the historical record it is about (§1).
 *  - **No `createdBy`.** The operator comes from the access token; a request cannot attribute a
 *    correction to somebody else.
 *  - **No write-off, recovery, liability or settlement field**, because `CodCorrectionType` has no
 *    value that would accept one. Who absorbs a shortfall is undecided (§2).
 *
 * ## The value pair is checked against the type
 *
 * Optional here and enforced in `CodCorrection`, which is where the rule belongs: a
 * `RECORDING_MISTAKE` must carry both amounts and no reference, a `REFERENCE_CORRECTION` the
 * reverse, and the other two neither. Expressing it in the DTO would need four request shapes and
 * would still leave the domain rule to be written a second time.
 *
 * ## `idempotencyKey` is a body field, not a header
 *
 * The project's settled choice — Module 06's `CheckoutDto`, Module 04's `ReserveStockDto` and
 * Module 05's dispense input all carry one, and the parent design records a header + interceptor as
 * explicitly not adopted. Module 08 has no header decorator to reuse and this work is not the place
 * to invent a cross-cutting one; the guarantee is the same either way, because it is the unique
 * index on `cod_corrections.idempotencyKey` that actually does the work.
 */
export class RecordCodCorrectionDto {
  @IsEnum(CodCorrectionType)
  type!: CodCorrectionType;

  /** The handover this corrects, when it is not the collection itself. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  remittanceId?: string;

  /** The finding this corrects. Required by the domain for a `RECONCILIATION_MISTAKE`. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  reconciliationId?: string;

  /** Minor units (ADR-005). Required together for a `RECORDING_MISTAKE`, refused otherwise. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  originalAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  correctedAmount?: number;

  /** Required for a `REFERENCE_CORRECTION`, refused otherwise. Opaque handles, never payloads. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CORRECTION_REFERENCE_LENGTH)
  originalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_CORRECTION_REFERENCE_LENGTH)
  correctedReference?: string;

  /** Required. A correction without a stated reason is an unexplained change to the record. */
  @IsString()
  @MaxLength(MAX_CORRECTION_REASON_LENGTH)
  reason!: string;

  /** The caller-supplied replay key (§9). Bounds match Module 06's and Module 07's. */
  @IsString()
  @MinLength(MIN_CORRECTION_IDEMPOTENCY_KEY_LENGTH)
  @MaxLength(MAX_CORRECTION_IDEMPOTENCY_KEY_LENGTH)
  idempotencyKey!: string;
}

/**
 * `POST /admin/delivery/cod-reconciliation/:collectionId/disputes` (§5).
 *
 * One field. A dispute is "somebody is looking into this, and here is what about" — there is no
 * assignee, no priority, no category, no due date and no attachment, because none of those exists
 * in a lifecycle with two states (§5's "do not build a full case-management system").
 *
 * No `status` either: a dispute is opened `OPEN`, and the only other state is reached through the
 * resolve route by an authorized operator. A request that could set the status would be a request
 * that could open an already-closed dispute.
 */
export class OpenCodDisputeDto {
  @IsString()
  @MaxLength(MAX_CORRECTION_REASON_LENGTH)
  reason!: string;
}

/**
 * `POST /admin/delivery/cod-reconciliation/:collectionId/disputes/:disputeId/resolve` (§5).
 *
 * **Free text, and no outcome field.** An `outcome` enum here would want `RECOVERED`,
 * `WRITTEN_OFF` or `DRIVER_LIABLE`, and every one of those answers the commercial question the
 * design's Open Question 5 leaves open — so the platform would have decided who pays by way of a
 * DTO. An operator says what happened in their own words instead, and the decision stays where it
 * belongs.
 *
 * Optional, because "counted again, it was right after all" is a real resolution with nothing to
 * add — and `forbidNonWhitelisted` means a request cannot smuggle an amount, a status or a
 * settlement instruction in beside it.
 */
export class ResolveCodDisputeDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CORRECTION_REASON_LENGTH)
  resolutionNote?: string;
}
