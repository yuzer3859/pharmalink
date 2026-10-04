import {
  isRetryableTransactionConflict,
  isSerializationConflict,
  runWithMatchRetry,
  TRANSACTION_RETRY_MAX_ATTEMPTS,
} from './match-retry';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { ErrorCode } from '../../../../shared/errors/error-codes';

function fakeUow(run: IUnitOfWork['run']): IUnitOfWork {
  return { run };
}

function serializationError(code: 'P2034' | '40001' | '40P01' = 'P2034'): Error & {
  code: string;
} {
  return Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), {
    code,
  });
}

describe('isSerializationConflict', () => {
  it.each(['P2034', '40001', '40P01'] as const)('recognizes Postgres code %s', (code) => {
    expect(isSerializationConflict(serializationError(code))).toBe(true);
  });

  it('returns false for a non-serialization error', () => {
    expect(isSerializationConflict(new Error('boom'))).toBe(false);
  });

  it('returns false for non-object/null values', () => {
    expect(isSerializationConflict(null)).toBe(false);
    expect(isSerializationConflict(undefined)).toBe(false);
    expect(isSerializationConflict('P2034')).toBe(false);
  });
});

describe('isRetryableTransactionConflict', () => {
  it('is retryable for a serialization conflict', () => {
    expect(isRetryableTransactionConflict(serializationError())).toBe(true);
  });

  it('is not retryable for a permanent domain error', () => {
    expect(isRetryableTransactionConflict(new Error('PRESCRIPTION_EXHAUSTED'))).toBe(false);
  });
});

describe('runWithMatchRetry', () => {
  it('returns the result on first-attempt success without retrying', async () => {
    const run = jest.fn().mockImplementation(async (work: (tx: unknown) => unknown) => work({}));
    const work = jest.fn().mockResolvedValue('ok');

    const result = await runWithMatchRetry(fakeUow(run), work);

    expect(result).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('retries on a retryable serialization conflict and succeeds on a later attempt', async () => {
    const work = jest
      .fn()
      .mockRejectedValueOnce(serializationError())
      .mockRejectedValueOnce(serializationError('40001'))
      .mockResolvedValueOnce('recovered');
    const run = jest.fn().mockImplementation(async (w: (tx: unknown) => unknown) => w({}));

    const result = await runWithMatchRetry(fakeUow(run), work);

    expect(result).toBe('recovered');
    expect(run).toHaveBeenCalledTimes(3);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('re-executes the transaction callback from the beginning on every retry (no cached result)', async () => {
    let sideEffectCount = 0;
    const work = jest.fn().mockImplementation(async () => {
      sideEffectCount += 1;
      if (sideEffectCount < 3) {
        throw serializationError();
      }
      return sideEffectCount;
    });
    const run = jest.fn().mockImplementation(async (w: (tx: unknown) => unknown) => w({}));

    const result = await runWithMatchRetry(fakeUow(run), work);

    expect(result).toBe(3);
    expect(sideEffectCount).toBe(3);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('stops at TRANSACTION_RETRY_MAX_ATTEMPTS and throws a deterministic CONFLICT', async () => {
    const run = jest.fn().mockRejectedValue(serializationError());

    await expect(runWithMatchRetry(fakeUow(run), jest.fn())).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(run).toHaveBeenCalledTimes(TRANSACTION_RETRY_MAX_ATTEMPTS);
  });

  it('never exceeds the configured max attempts (bounded, no infinite loop)', async () => {
    const run = jest.fn().mockRejectedValue(serializationError());

    await expect(runWithMatchRetry(fakeUow(run), jest.fn(), 3)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent domain/application error and rethrows it unchanged', async () => {
    const domainError = new Error('PRESCRIPTION_EXHAUSTED');
    const run = jest.fn().mockRejectedValue(domainError);

    await expect(runWithMatchRetry(fakeUow(run), jest.fn())).rejects.toBe(domainError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not retry a generic unrelated error', async () => {
    const genericError = new Error('unrelated failure');
    const run = jest.fn().mockRejectedValue(genericError);

    await expect(runWithMatchRetry(fakeUow(run), jest.fn())).rejects.toBe(genericError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('preserves the original error message as the cause when retries are exhausted', async () => {
    const err = serializationError();
    const run = jest.fn().mockRejectedValue(err);

    await expect(runWithMatchRetry(fakeUow(run), jest.fn())).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
      details: { cause: err.message },
    });
  });
});
