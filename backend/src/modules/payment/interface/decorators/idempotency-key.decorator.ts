import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { IdempotencyKey } from '../../domain/value-objects/idempotency-key.vo';
import { PaymentErrors } from '../../domain/errors';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Extracts and validates the `Idempotency-Key` header (§9 — "All mutating ops require
 * `Idempotency-Key`").
 *
 * ## The division of responsibility
 *
 * This decorator does exactly three things: **extract, validate, forward**. It does not look
 * anything up, does not compare requests, and does not decide what a replay means.
 *
 * All of that already lives in the commands, which own the real idempotency: they look the key
 * up, compare the request against the committed payment, return the original result for a replay
 * and raise `IDEMPOTENCY_CONFLICT` for a key reused for a different request — backed by the
 * `payments.idempotencyKey` unique index, which is what actually makes concurrent duplicates
 * safe. Re-implementing any of that in an HTTP interceptor would create a second, weaker
 * mechanism racing the real one; there is no shared idempotency interceptor in this project to
 * reuse, and this task is not the place to invent one.
 *
 * Validation happens here so a malformed key is a `400` before a command runs, rather than
 * surfacing later from deep inside a money flow. It reuses the domain's own `IdempotencyKey`
 * value object, so the header and the persisted column can never disagree about what is valid.
 */
export const RequireIdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers[IDEMPOTENCY_KEY_HEADER];

    // Express lower-cases header names, but a repeated header arrives as an array. A request that
    // supplies two different keys has no single idempotency identity, so it is rejected rather
    // than resolved by picking one.
    if (Array.isArray(raw)) {
      throw PaymentErrors.validation('Exactly one Idempotency-Key header is required.', {
        field: 'Idempotency-Key',
      });
    }
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw PaymentErrors.validation('The Idempotency-Key header is required.', {
        field: 'Idempotency-Key',
      });
    }

    // Throws VALIDATION_ERROR for a key that is too short, too long, or carries whitespace or
    // control characters — the same rules the persisted key obeys.
    return IdempotencyKey.of(raw).value;
  },
);
