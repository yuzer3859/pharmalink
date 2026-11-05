import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AdminErrors } from '../../domain/errors';

/**
 * The maker's `Idempotency-Key` for a maker-checker action (Work 83). Admin's own copy of the
 * payment module's rule (8–128 printable, non-whitespace ASCII characters, exactly one header), so
 * Admin does not reach into Module 07's interface layer; the key reaches Module 07 only through
 * `approval:<id>` or the gate, and Module 07 validates what it persists.
 */
export const RequireIdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const raw = context.switchToHttp().getRequest<Request>().headers['idempotency-key'];
  if (Array.isArray(raw)) {
    throw AdminErrors.validation('Exactly one Idempotency-Key header is required.', { field: 'Idempotency-Key' });
  }
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    throw AdminErrors.validation('The Idempotency-Key header is required.', { field: 'Idempotency-Key' });
  }
  if (value.length < 8 || value.length > 128 || !/^[\x21-\x7e]+$/.test(value)) {
    throw AdminErrors.validation('Idempotency-Key must be 8 to 128 printable characters without spaces.', {
      field: 'Idempotency-Key',
    });
  }
  return value;
});
