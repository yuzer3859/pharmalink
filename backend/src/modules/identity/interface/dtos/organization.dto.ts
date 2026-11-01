import { IsString, Length, Matches } from 'class-validator';

/**
 * `POST /organizations/pharmacy` (Work 65). These two fields are the whole contract: owner, type,
 * status, roles and licence data are decided by the server, and the global ValidationPipe
 * (`forbidNonWhitelisted`) rejects a request that tries to send any of them.
 */
export class ApplyPharmacyOrganizationDto {
  /** The organisation's legal name. Whitespace is normalized server-side. */
  @IsString()
  @Length(2, 200)
  @Matches(/\S/, { message: 'legalName must not be blank' })
  legalName!: string;

  /** Client-generated retry key (e.g. a UUID), unique per owner. Same convention as checkout. */
  @IsString()
  @Length(8, 128)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'idempotencyKey may contain only letters, digits, "-" and "_"' })
  idempotencyKey!: string;
}
