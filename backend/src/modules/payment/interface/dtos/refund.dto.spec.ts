// The decorator metadata `class-transformer`/`class-validator` read is emitted by TypeScript but
// only *readable* once `reflect-metadata` has installed `Reflect.getMetadata`. Nest's own
// bootstrap pulls it in, so the e2e suites get it for free; a plain unit spec has to ask.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RefundDestination } from '../../domain/enums';
import { RefundPaymentDto } from './refund.dto';

/**
 * `RefundPaymentDto` against the *global* pipe configuration, not a convenient subset of it:
 * `whitelist`, `forbidNonWhitelisted`, `transform` and `enableImplicitConversion` are exactly the
 * options `AppModule` binds. Reproducing them here is what makes this spec meaningful — a rule
 * that only holds under laxer options would pass a naive test and fail in production.
 *
 * The e2e suite proves the same rules over real HTTP; this proves them without a database, which
 * is where a regression in the validation contract is cheapest to catch.
 */
const PIPE_OPTIONS = { enableImplicitConversion: true };

function validate(payload: unknown): string[] {
  const dto = plainToInstance(RefundPaymentDto, payload, PIPE_OPTIONS);
  return validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).flatMap((error) => Object.keys(error.constraints ?? {}).map(() => error.property));
}

const VALID = { reason: 'customer cancellation', destination: RefundDestination.ORIGINAL };

describe('RefundPaymentDto (§9.3)', () => {
  it('accepts §9.3 full-refund body — amount omitted', () => {
    expect(validate(VALID)).toEqual([]);
  });

  it('accepts §9.3 partial-refund body', () => {
    expect(
      validate({ amount: 250, reason: 'partial dispute', destination: RefundDestination.WALLET }),
    ).toEqual([]);
  });

  it.each([
    ['ORIGINAL', RefundDestination.ORIGINAL],
    ['WALLET', RefundDestination.WALLET],
  ])('accepts the %s destination', (_label, destination) => {
    expect(validate({ ...VALID, destination })).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // amount
  // -------------------------------------------------------------------------------------------

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 250.5],
    ['a non-numeric string', 'lots'],
    ['an object', { minor: 250 }],
    ['an array', [250]],
    ['a boolean', true],
  ])('rejects %s as an amount', (_label, amount) => {
    expect(validate({ ...VALID, amount })).toContain('amount');
  });

  it('treats an explicit null amount as omitted, exactly as the command does', () => {
    // `@IsOptional` skips null as well as undefined, and `RefundPaymentInput` reads `null` and
    // `undefined` identically as "refund everything still refundable". The two agree by
    // construction rather than by coincidence.
    expect(validate({ ...VALID, amount: null })).toEqual([]);
  });

  it('rejects a fractional amount even when sent as a string', () => {
    // `enableImplicitConversion` turns "250.5" into the number 250.5 — `@IsInt` must still catch
    // it, or a sub-santim refund would reach the ledger.
    expect(validate({ ...VALID, amount: '250.5' })).toContain('amount');
  });

  it('accepts an integer amount sent as a string, as the global pipe converts it', () => {
    expect(validate({ ...VALID, amount: '250' })).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // reason
  // -------------------------------------------------------------------------------------------

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a number', 42],
    ['an object', { text: 'because' }],
    ['an array', ['because']],
    ['null', null],
  ])('rejects a %s reason', (_label, reason) => {
    expect(validate({ ...VALID, reason })).toContain('reason');
  });

  it('rejects a reason longer than 500 characters', () => {
    expect(validate({ ...VALID, reason: 'x'.repeat(501) })).toContain('reason');
    expect(validate({ ...VALID, reason: 'x'.repeat(500) })).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // destination
  // -------------------------------------------------------------------------------------------

  it.each([
    ['missing', undefined],
    ['unknown', 'BANK_ACCOUNT'],
    ['lower-case', 'wallet'],
    ['empty', ''],
    ['a number', 1],
  ])('rejects a %s destination', (_label, destination) => {
    expect(validate({ ...VALID, destination })).toContain('destination');
  });

  // -------------------------------------------------------------------------------------------
  // What a client may not send at all
  // -------------------------------------------------------------------------------------------

  it.each([
    'customerUserId',
    'paymentId',
    'refundId',
    'status',
    'paymentStatus',
    'approvedBy',
    'provider',
    'providerRef',
    'idempotencyKey',
    'initiator',
    'ledgerReference',
    'feeClawback',
    'currency',
    // PCI (BRULE-26): these fields do not exist and never may. `forbidNonWhitelisted` is what
    // makes that a rejection rather than a silent drop.
    'pan',
    'cardNumber',
    'cvv',
  ])('refuses a client-supplied %s outright', (field) => {
    expect(validate({ ...VALID, [field]: 'attacker-value' })).toContain(field);
  });
});
