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
import { MAX_SETTLEMENT_PAGE_SIZE } from '../../application/queries/get-settlement.query';
import { SettlementStatus } from '../../domain/enums';

const MAX_ID_LENGTH = 64;

/** Trims and upper-cases a currency code before validation, so `etb` and `ETB` behave alike. */
const UpperCase = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value));

/**
 * `GET /settlements` (§9.6) — the filters, and **only** the filters.
 *
 * Every field here narrows a result set the caller is already entitled to see. None of them
 * establishes entitlement: `pharmacyId` is intersected with the pharmacies resolved from the
 * access token, so naming another provider's pharmacy returns an empty page rather than that
 * provider's statements. There is deliberately no `organizationId` and no `userId` field —
 * `forbidNonWhitelisted` turns sending one into a `400` rather than a silently ignored extra.
 *
 * The filters are exactly the columns a statement already has. Nothing here asks the application
 * layer a question it could not answer by selecting rows — no "unsettled orders", no "pending
 * payouts", no figure recomputed at read time.
 *
 * `page`/`size` follow the same convention as `ListWalletTransactionsQueryDto` and
 * `ListCouponsQueryDto`.
 */
export class ListSettlementsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  pharmacyId?: string;

  @IsOptional()
  @UpperCase()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be a three-letter ISO-4217 code (e.g. ETB).',
  })
  currency?: string;

  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;

  /** Statements whose period *starts* at or after this instant. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Statements whose period *ends* at or before this instant. */
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
  @Max(MAX_SETTLEMENT_PAGE_SIZE)
  size?: number = 20;
}

/**
 * `POST /admin/finance/settlements/run` (§9.6 — "`{ period }` → generate draft settlements").
 *
 * ## Why there is no `Idempotency-Key` header on this route
 *
 * These four fields **are** the idempotency key. `RunSettlementCommand`'s identity is
 * `(pharmacyId, periodStart, periodEnd, currency)` behind a unique index, so a repeated request
 * with the same body necessarily replays the committed statement — including two that arrive
 * concurrently, where the loser of the index race returns the winner's row. Requiring a header
 * the command has no parameter for would advertise a guarantee the code does not implement, while
 * the guarantee it *does* implement is the stronger one: identical requests are identical
 * regardless of what header accompanied them.
 *
 * ## Why `pharmacyId` is required
 *
 * §9.6 describes the route as generating draft settlements, plural. `RunSettlementCommand` settles one
 * provider, and deciding *which* providers a period covers — every pharmacy with activity? every
 * verified one? — is a business rule that does not exist anywhere in this module yet. Inventing it
 * in a controller is exactly what this task must not do, so the route settles the provider it is
 * given and the fan-out stays an explicit gap.
 *
 * The period is half-open `[start, end)` (`SettlementPeriod`), which is what keeps a posting on a
 * boundary in exactly one statement.
 */
export class RunSettlementDto {
  @IsString()
  @MaxLength(MAX_ID_LENGTH)
  pharmacyId!: string;

  @IsDateString()
  periodStart!: string;

  @IsDateString()
  periodEnd!: string;

  /** Defaults to the platform's base currency in the command; a statement is single-currency. */
  @IsOptional()
  @UpperCase()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be a three-letter ISO-4217 code (e.g. ETB).',
  })
  currency?: string;
}
