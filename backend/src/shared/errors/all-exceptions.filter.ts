import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { AppLogger } from '../logging/app-logger.service';
import { ApiException } from './api-exception';
import { ErrorBody, errorEnvelope } from './envelope';
import { ErrorCode } from './error-codes';

/**
 * Catches every unhandled error and returns the standard ErrorEnvelope. Order of handling:
 * ApiException (domain) → HttpException (Nest/validation) → unknown (500, message hidden).
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId =
      (request?.headers?.['x-request-id'] as string) ?? randomUUID();

    const { status, body } = this.translate(exception);

    if (status >= 500) {
      this.logger.error(
        { message: 'Unhandled error', code: body.code, path: request?.url, detail: body.message },
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn({ message: 'Handled error', code: body.code, path: request?.url });
    }

    // Mirrors ResponseInterceptor's success path so a request can be traced by its
    // x-request-id header regardless of whether it succeeded or failed.
    response.setHeader('x-request-id', requestId);
    response.status(status).json(errorEnvelope(body, requestId));
  }

  private translate(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof ApiException) {
      return {
        status: exception.httpStatus,
        body: { code: exception.code, message: exception.message, details: exception.details },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : ((res as Record<string, unknown>)?.message as string) ?? exception.message;
      const details =
        typeof res === 'object' ? (res as Record<string, unknown>)?.message : undefined;
      return {
        status,
        body: { code: this.mapHttpStatusToCode(status), message, details },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' },
    };
  }

  private mapHttpStatusToCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.BUSINESS_RULE_VIOLATION;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.DEPENDENCY_UNAVAILABLE;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
