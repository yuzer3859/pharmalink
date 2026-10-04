import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_COD_COLLECTION_PAGE_SIZE } from '../../application/queries/list-cod-collections.query';
import {
  MAX_REMITTANCE_NOTE_LENGTH,
  MAX_REMITTANCE_REFERENCE_LENGTH,
} from '../../domain/entities/cod-remittance.entity';
import { CodCollectionStatus } from '../../domain/enums';

const MAX_ID_LENGTH = 64;

/** Trims and upper-cases a currency code before validation, so `etb` and `ETB` behave alike. */
const UpperCase = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value));

/**
 * `POST /admin/delivery/cod-reconciliation/:collectionId/remit` (§1, §3).
 *
 * ## What the operator states, and what they cannot
 *
 * Four fields, and **`remittedAmount` is required** — never defaulted from the collection. §4 is
 * explicit that the remittance records the amount *actually handed to PharmaLink*, and a DTO with an
 * optional amount would make the common path "assume the driver handed over what they said", which
 * is the one assumption the whole step exists to stop making.
 *
 * There is deliberately **no field** for: the expected amount, the collected amount, the driver, the
 * collection's status, the reconciliation outcome, a settlement reference, or a ledger instruction.
 * `forbidNonWhitelisted` turns sending any of them into a `400` rather than a silently ignored
 * extra, so the request cannot even appear to restate a fact it does not own.
 *
 * ## `reference` is required, and generically named
 *
 * §11's instruction, taken literally: the field is `reference`, not `bankReference`,
 * `telebirrReference` or `depositSlipNumber`. It identifies the **PharmaLink-side** act — a cash
 * office batch, an internal transfer id — and naming a rail here would put a provider into a
 * delivery DTO and make every new rail a schema change in the wrong module.
 *
 * It is required where a collection's `providerReference` is optional, because cash can honestly
 * have no reference while an act PharmaLink performed can always be named — and §19's grouping has
 * nothing to group on without one.
 */
export class RecordCodRemittanceDto {
  /** Minor units (ADR-005). Zero is legitimate: a channel that turned up with nothing is a fact. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  remittedAmount!: number;

  @IsString()
  @MaxLength(MAX_REMITTANCE_REFERENCE_LENGTH)
  reference!: string;

  /** Defaults to the collection's own currency; naming a different one is refused, not converted. */
  @IsOptional()
  @UpperCase()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be a three-letter ISO-4217 code (e.g. ETB).',
  })
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_REMITTANCE_NOTE_LENGTH)
  note?: string;

  /** When the money changed hands, if a Friday handover is being keyed in on Monday. */
  @IsOptional()
  @IsDateString()
  remittedAt?: string;
}

/**
 * `POST /admin/delivery/cod-reconciliation/:collectionId/reconcile` (§5, §6, §7).
 *
 * ## There is no `outcome` field, and that is the point
 *
 * Whether the books balanced is arithmetic over three immutable amounts, not something an operator
 * declares. `CodCollectionPolicy.classifyReconciliation` computes it and the command passes what the
 * policy returned, so there is no request — malformed, malicious or merely mistaken — that can mark
 * a shortfall `ACCEPTED`. A reconciliation able to say the books balanced when they did not would
 * make every other guarantee in this module decorative.
 *
 * Nor is there an `amount` field of any kind, a status, a `settlementRef`, or anything that could
 * instruct a downstream ledger. §15 and §16 keep all of that on Module 07's side.
 *
 * ## The two fields that do exist
 *
 * `reference` is the reconciliation run's own generic handle — a cash-office session, a finance
 * batch label — and `note` is §7's "minimum explicit field rather than a large dispute system":
 * somewhere to write why a difference happened, for the reader who has to act on it. Both optional,
 * because a clean reconciliation of an exact remittance genuinely has nothing to add.
 */
export class ReconcileCodCollectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REMITTANCE_REFERENCE_LENGTH)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_REMITTANCE_NOTE_LENGTH)
  note?: string;
}

/**
 * `GET /admin/delivery/cod-reconciliation` (§18, §19).
 *
 * The five groupings §19 names — channel, status, currency, period, handover reference — plus
 * `orderId`, which is the question support actually arrives with ("the customer is asking about
 * order X"). Every field narrows a result set the permission already entitles the caller to see;
 * none establishes entitlement, because this surface is platform-wide.
 *
 * `page`/`size` follow the same convention as every other list in the project.
 */
export class ListCodCollectionsQueryDto {
  /** `driver_profiles.id` — the delivery channel, not a Module 01 user id. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  driverId?: string;

  @IsOptional()
  @IsEnum(CodCollectionStatus)
  status?: CodCollectionStatus;

  @IsOptional()
  @UpperCase()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be a three-letter ISO-4217 code (e.g. ETB).',
  })
  currency?: string;

  /** Every collection handed over under one handle: §19's batch, without a batch table. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REMITTANCE_REFERENCE_LENGTH)
  remittanceReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  orderId?: string;

  /** Collections whose money changed hands at or after this instant. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** ...and at or before this one. */
  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_COD_COLLECTION_PAGE_SIZE)
  size?: number = 20;
}
