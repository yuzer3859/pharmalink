import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SuccessEnvelope, successEnvelope } from './envelope';

/**
 * Wraps every successful controller return value in the standard SuccessEnvelope and ensures a
 * request id exists (echoed via the x-request-id response header for tracing).
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, SuccessEnvelope<T>> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessEnvelope<T>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId =
      (request?.headers?.['x-request-id'] as string) ?? randomUUID();
    response.setHeader('x-request-id', requestId);

    return next.handle().pipe(map((data) => successEnvelope(data, requestId)));
  }
}
