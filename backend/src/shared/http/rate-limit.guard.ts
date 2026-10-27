import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiException } from '../errors/api-exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * The global rate-limit guard (Work 59). Two changes from `ThrottlerGuard`:
 *
 * - HTTP only. Global guards also run on WebSocket handlers, where there is no HTTP request to
 *   identify; the tracking socket is authenticated and has its own cadence rules.
 * - A refused request gets the standard `Retry-After` header (seconds) and the platform's error
 *   envelope with `RATE_LIMITED` / 429, instead of a bare Nest exception.
 *
 * The client identity is `req.ip` (the guard's default tracker): the TCP peer, or — only when
 * `TRUST_PROXY` names the reverse proxies — the nearest untrusted address in `X-Forwarded-For`.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== 'http';
  }

  protected async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const res = context.switchToHttp().getResponse<Response>();
    res.header('Retry-After', String(Math.max(1, detail.timeToBlockExpire)));
    throw new ApiException(ErrorCode.RATE_LIMITED, 'Too many requests. Try again later.');
  }
}
