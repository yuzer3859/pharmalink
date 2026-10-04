import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { CodCollectionMethod } from '../../domain/enums';
import { MAX_PROVIDER_REFERENCE_LENGTH } from '../../domain/entities/cod-collection.entity';

/**
 * `POST /delivery/jobs/{id}/cod-collection`'s body (§17, F-COD-01).
 *
 * ## Four fields, and none of them is the amount due
 *
 * There is no `expectedAmount`, no `orderTotal`, no `driverId`, no `status` and no `reconciled`.
 * That is the enforcement of §4 and §17 rather than a comment about them: the global
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so a client that sends `expectedAmount` gets a
 * `400` naming the property rather than a collection quietly recorded against a figure it chose.
 * A collection channel does not get to say how much it was asked to collect, and it certainly does
 * not get to mark its own cash reconciled.
 *
 * What a driver *does* supply is what only they can know: how much was handed over, how, a
 * reference if there is one, and when — four declarations, each of which the row records as a
 * declaration rather than as a verified fact.
 */
export class RecordCodCollectionDto {
  /**
   * What the driver received, in ETB minor units (ADR-005).
   *
   * `@Min(0)` rather than `@Min(1)`: a driver recording that the customer handed over nothing is
   * making a real and useful statement, and refusing it would push them towards recording a figure
   * that is not true. An integer, because a fraction of a santim cannot change hands.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  collectedAmount!: number;

  /** `CASH` or `ELECTRONIC`. Never a provider name — see `CodCollectionMethod`. */
  @IsEnum(CodCollectionMethod)
  method!: CodCollectionMethod;

  /**
   * An opaque transaction reference for an electronic collection — a number a human can quote
   * during reconciliation.
   *
   * **Generic on purpose.** There is no field here for a provider payload, a callback body, a
   * signature, an account or card number, or anything a provider would call a secret; §9 and §12
   * both rule those out, and a delivery module has no business holding any of them. Rejected
   * outright on a `CASH` collection, which has no provider and therefore nothing to reference.
   */
  @IsString()
  @MaxLength(MAX_PROVIDER_REFERENCE_LENGTH)
  @IsOptional()
  providerReference?: string;

  /**
   * When the money actually changed hands, if that is not now.
   *
   * Accepted because a driver's handset queues submissions when the network is down at somebody's
   * door, and a reconciliation that cannot separate "collected at 14:02" from "recorded at 14:40"
   * cannot explain the gap. The platform records both: this value and its own clock.
   */
  @IsDateString()
  @IsOptional()
  collectedAt?: string;
}
